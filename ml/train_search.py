"""Offline BGE fine-tuning with weak title/content labels and validation selection."""

import argparse
from collections import defaultdict, deque
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import random
import time
import uuid

import numpy as np
import torch
from torch.nn import functional as F
from transformers import AutoModel, AutoTokenizer

from prepare_neural_pairs import prepare_pairs, load_training_splits
from research_ml.data import write_json, fingerprint, read_json


ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = "BAAI/bge-small-en-v1.5"
REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "
MAX_LENGTH = 512


def encode_texts(model, tokenizer, texts, device, is_query=False):
    if is_query:
        texts = [QUERY_INSTRUCTION + text for text in texts]
    inputs = tokenizer(texts, padding=True, truncation=True,
                       max_length=MAX_LENGTH, return_tensors="pt")
    inputs = {key: value.to(device) for key, value in inputs.items()}
    output = model(**inputs).last_hidden_state[:, 0, :]

    return F.normalize(output.float(), p=2, dim=1)


def contrastive_loss(query_vectors, document_vectors, temperature):
    if query_vectors.shape != document_vectors.shape or len(query_vectors) < 2:
        raise ValueError("Need at least two aligned query/document pairs")
    if not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("Temperature must be finite and positive")
    logits = query_vectors @ document_vectors.T / temperature
    targets = torch.arange(len(query_vectors), device=logits.device)

    return F.cross_entropy(logits, targets), logits


def epoch_rows(rows, seed):
    """At most one member of each known duplicate group per epoch."""
    groups = defaultdict(list)
    for row in rows:
        groups[row["group_id"]].append(row)
    rng = random.Random(seed)
    chosen = [rng.choice(group) for _, group in sorted(groups.items())]
    rng.shuffle(chosen)
    return chosen


def complete_epoch_batches(rows, lengths, batch_size, seed):
    """Use every pair once, length-bucketed, without repeated groups in a batch."""
    rng = random.Random(seed)
    ordered = list(rows)
    rng.shuffle(ordered)
    ordered.sort(key=lambda row: lengths[row["positive_paper_id"]] // 32)
    pending, batches = deque(ordered), []
    while pending:
        batch, groups = [], set()
        for _ in range(len(pending)):
            row = pending.popleft()
            if row["group_id"] in groups:
                pending.append(row)
            else:
                batch.append(row)
                groups.add(row["group_id"])
            if len(batch) == batch_size:
                break
        batches.append(batch)
    singletons = [batch[0] for batch in batches if len(batch) == 1]
    batches = [batch for batch in batches if len(batch) > 1]
    for row in singletons:
        for batch in reversed(batches):
            if len(batch) <= batch_size and row["group_id"] not in {r["group_id"] for r in batch}:
                batch.append(row)
                break
        else:
            raise ValueError("Cannot create valid negative-containing batches for all groups")
    if sorted(r["positive_paper_id"] for batch in batches for r in batch) != sorted(r["positive_paper_id"] for r in rows):
        raise ValueError("Full-epoch sampler omitted or repeated a pair")
    if any(len({r["group_id"] for r in batch}) != len(batch) for batch in batches):
        raise ValueError("A duplicate group appears twice in a batch")
    rng.shuffle(batches)
    return batches


def evaluate_proxy(model, tokenizer, rows, batch_size, device, temperature):
    """Fixed validation subset vs its own content pool, NOT corpus retrieval."""
    model.eval()
    queries, documents = [], []
    with torch.inference_mode():
        for start in range(0, len(rows), batch_size):
            batch = rows[start:start + batch_size]
            queries.append(encode_texts(model, tokenizer, [r["query"] for r in batch], device, True))
            documents.append(encode_texts(model, tokenizer, [r["positive_text"] for r in batch], device))
        q, d = torch.cat(queries), torch.cat(documents)
        loss, logits = contrastive_loss(q, d, temperature)
        if not torch.isfinite(loss):
            raise ValueError("Nonfinite validation loss")
        targets = torch.arange(len(rows), device=device)
        return {
            "scope": "fixed weak-label validation subset against its own candidate pool",
            "queries_and_candidates": len(rows), "cross_entropy": loss.item(),
            "top1_title_content_accuracy": (logits.argmax(1) == targets).float().mean().item(),
        }


def train(args):
    if args.batch_size < 2 or args.max_steps < 1 or args.epochs < 1 or args.validation_size < 2:
        raise ValueError("Batch/validation size >=2 and steps/epochs >=1 required")
    if args.threads < 1 or not math.isfinite(args.learning_rate) or args.learning_rate <= 0:
        raise ValueError("Positive finite learning rate and positive thread count required")
    if args.device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA unavailable; use CPU")
    torch.set_num_threads(args.threads)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if args.device == "cuda":
        torch.cuda.manual_seed_all(args.seed)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    run_kind = "bge-full" if args.full_epoch else "bge-pilot"
    run_dir = Path(args.output_root).resolve() / f"{run_kind}-{stamp}-{uuid.uuid4().hex[:8]}"
    run_dir.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    print(f"New run: {run_dir}", flush=True)
    try:
        prior_dir = Path(args.continue_from).resolve() if args.continue_from else None
        prior_config = read_json(prior_dir / "config.json") if prior_dir else None
        data_dir = (Path(args.data_dir).resolve() if args.data_dir else
                    Path(prior_config["data_dir"]) if prior_config else run_dir / "data")
        if not args.data_dir and not prior_dir:
            prepare_pairs(args.corpus, args.benchmark, data_dir, args.seed)
        splits, data_manifest = load_training_splits(data_dir)
        if prior_config and prior_config["data_manifest"]["split_fingerprints"] != data_manifest["split_fingerprints"]:
            raise ValueError("Continuation dataset differs from source experiment")
        validation_rows = epoch_rows(splits["validation"], args.seed + 10000)[:args.validation_size]
        if len(validation_rows) < 2:
            raise ValueError("Need at least two validation groups")
        write_json(run_dir / "validation_subset_ids.json", [r["positive_paper_id"] for r in validation_rows])
        print(f"Screened pair counts: {data_manifest['counts']}", flush=True)

        model_source = prior_dir / "checkpoint" if prior_dir else MODEL_ID
        source_args = {} if prior_dir else {"revision": REVISION}
        tokenizer = AutoTokenizer.from_pretrained(
            model_source, **source_args, local_files_only=True,
            padding_side="right", truncation_side="right",
        )
        model = AutoModel.from_pretrained(
            model_source, **source_args, local_files_only=True, use_safetensors=True,
        ).to(args.device)

        if getattr(model, "pooler", None) is not None:
            model.pooler.requires_grad_(False)
        parameters = {name: p for name, p in model.named_parameters() if p.requires_grad}
        decay = [p for name, p in parameters.items() if p.ndim > 1]
        no_decay = [p for name, p in parameters.items() if p.ndim <= 1]
        optimizer = torch.optim.AdamW(
            [{"params": decay, "weight_decay": 0.01}, {"params": no_decay, "weight_decay": 0.0}],
            lr=args.learning_rate,
        )
        prior_steps = 0
        if prior_dir:
            saved = torch.load(prior_dir / "optimizer_state.pt", map_location="cpu", weights_only=True)
            optimizer.load_state_dict(saved["optimizer"])
            for group in optimizer.param_groups:
                group["lr"] = args.learning_rate
            for state in optimizer.state.values():
                for key, value in state.items():
                    if torch.is_tensor(value) and key != "step":
                        state[key] = value.to(args.device)
            torch.set_rng_state(saved["torch_rng_state"])
            prior_steps = saved["steps"]
            print(f"Continuing weights and AdamW state after {prior_steps} prior steps; starting new complete epochs.", flush=True)
        watched = {
            "token_embeddings": "embeddings.word_embeddings.weight",
            "position_embeddings": "embeddings.position_embeddings.weight",
            "query_weights_block0": "encoder.layer.0.attention.self.query.weight",
            "key_weights_block0": "encoder.layer.0.attention.self.key.weight",
            "value_weights_block0": "encoder.layer.0.attention.self.value.weight",
        }
        config = {
            "status": "started", "model_id": MODEL_ID, "base_revision": REVISION,
            "data_dir": str(data_dir), "data_manifest": data_manifest,
            "continued_from": str(prior_dir) if prior_dir else None,
            "prior_optimizer_steps": prior_steps, "full_epoch": args.full_epoch,
            "query_instruction": QUERY_INSTRUCTION,
            "document_text": "keywords + abstract; leading title removed",
            "pooling": "final CLS", "normalization": "L2", "max_length": MAX_LENGTH,
            "loss": "query-to-document in-batch contrastive cross entropy",
            "temperature": args.temperature, "batch_size": args.batch_size,
            "learning_rate": args.learning_rate, "optimizer": "AdamW",
            "weight_decay_matrix_parameters": 0.01, "gradient_clip_max_norm": 1.0,
            "max_steps": args.max_steps, "epochs_limit": args.epochs, "seed": args.seed,
            "device": args.device, "threads": args.threads,
            "trainable_parameters": sum(p.numel() for p in parameters.values()),
            "sampling": ("every pair once per epoch; length buckets; distinct groups per batch; merge singleton"
                         if args.full_epoch else "one random representative per duplicate group per epoch; drop final singleton"),
            "versions": {name: importlib.metadata.version(name) for name in ("torch", "transformers", "numpy")},
            "sources_sha256": {
                name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
                for name in ("train_search.py", "prepare_neural_pairs.py", "audit_pair_splits.py")
            },
            "limitations": data_manifest["limitations"] + [
                "Other batch documents are assumed negatives; related papers may be false negatives.",
                "Validation is a title/content proxy, not evidence of improved real-query search relevance.",
                "Saved pretrained paper vectors must be regenerated before use with this encoder.",
            ],
        }
        write_json(run_dir / "config.json", config)
        print("Evaluating fixed validation subset before training...", flush=True)
        before = evaluate_proxy(model, tokenizer, validation_rows, args.batch_size, args.device, args.temperature)
        print(f"Before: {before}", flush=True)

        lengths = {}
        if args.full_epoch:
            tokenized = tokenizer([r["positive_text"] for r in splits["train"]],
                                  truncation=True, max_length=MAX_LENGTH, padding=False)
            lengths = {row["positive_paper_id"]: len(ids)
                       for row, ids in zip(splits["train"], tokenized["input_ids"])}
            del tokenized

        steps, trace, seen_ids = 0, [], set()
        gradient_evidence = {}
        with (run_dir / "training.jsonl").open("x", encoding="utf-8") as log:
            for epoch in range(args.epochs):
                if args.full_epoch:
                    batches = complete_epoch_batches(splits["train"], lengths, args.batch_size, args.seed + epoch)
                else:
                    rows = epoch_rows(splits["train"], args.seed + epoch)
                    batches = [rows[start:start + args.batch_size] for start in range(0, len(rows), args.batch_size)]
                print(f"Epoch {epoch + 1}: {len(batches)} batches", flush=True)
                for batch_index, batch in enumerate(batches):
                    if len(batch) < 2:
                        continue
                    model.train()
                    optimizer.zero_grad(set_to_none=True)
                    q = encode_texts(model, tokenizer, [r["query"] for r in batch], args.device, True)
                    d = encode_texts(model, tokenizer, [r["positive_text"] for r in batch], args.device)
                    loss, logits = contrastive_loss(q, d, args.temperature)
                    if not torch.isfinite(loss):
                        raise ValueError("Nonfinite training loss")
                    loss.backward()
                    missing = [name for name, p in parameters.items() if p.grad is None]
                    if missing:
                        raise ValueError(f"Trainable parameters disconnected from loss: {missing}")

                    old_values = {}
                    if steps == 0:
                        for label, name in watched.items():
                            p = parameters[name]
                            grad_norm = p.grad.float().norm().item()
                            if not math.isfinite(grad_norm) or grad_norm == 0:
                                raise ValueError(f"No finite nonzero gradient for {name}")
                            gradient_evidence[label] = {"gradient_norm_before_clip": grad_norm}
                            old_values[label] = p.detach().clone()
                    total_norm = torch.nn.utils.clip_grad_norm_(list(parameters.values()), 1.0, error_if_nonfinite=True)
                    optimizer.step()
                    if steps == 0:
                        for label, old in old_values.items():
                            delta = (parameters[watched[label]].detach() - old).abs().max().item()
                            if not math.isfinite(delta) or delta <= 0:
                                raise ValueError(f"Parameter update not observed: {label}")
                            gradient_evidence[label]["max_abs_change_after_step1"] = delta
                        write_json(run_dir / "gradient_check.json", gradient_evidence)
                        del old_values, old
                    steps += 1
                    ids = [r["positive_paper_id"] for r in batch]
                    seen_ids.update(ids)
                    item = {
                        "step": steps, "epoch": epoch + 1, "batch_size": len(batch),
                        "paper_ids": ids, "loss_before_step": loss.item(),
                        "gradient_norm_before_clip": float(total_norm),
                        "elapsed_seconds": round(time.perf_counter() - started, 3),
                    }
                    trace.append(item)
                    log.write(json.dumps(item, allow_nan=False) + "\n")
                    log.flush()
                    if steps <= 3 or steps % 10 == 0 or batch_index + 1 == len(batches):
                        print(f"Epoch {epoch + 1}, batch {batch_index + 1}/{len(batches)} | loss {loss.item():.6f} | grad norm {float(total_norm):.4f}", flush=True)
                    if not args.full_epoch and steps >= args.max_steps:
                        break
                if not args.full_epoch and steps >= args.max_steps:
                    break
        if steps == 0:
            raise ValueError("No training batches")
        if args.full_epoch and len(seen_ids) != len(splits["train"]):
            raise ValueError("Full run did not cover every training paper")
        optimizer.zero_grad(set_to_none=True)
        after = evaluate_proxy(model, tokenizer, validation_rows, args.batch_size, args.device, args.temperature)

        checkpoint_dir = run_dir / "checkpoint"
        model.save_pretrained(checkpoint_dir, safe_serialization=True)
        tokenizer.save_pretrained(checkpoint_dir)


        torch.save({"optimizer": optimizer.state_dict(), "steps": prior_steps + steps,
                    "torch_rng_state": torch.get_rng_state()}, run_dir / "optimizer_state.pt")
        model.eval()
        with torch.inference_mode():
            verification_text = [validation_rows[0]["query"]]
            vector = encode_texts(model, tokenizer, verification_text, args.device, True).cpu().numpy()
        np.save(run_dir / "checkpoint_check_vector.npy", vector, allow_pickle=False)
        write_json(run_dir / "checkpoint_check_query.json", verification_text)
        report = {
            "status": "complete", "scope": ("complete-epoch weak-label fine-tuning" if args.full_epoch else "limited weak-label fine-tuning experiment"),
            "output_dir": str(run_dir), "checkpoint_dir": str(checkpoint_dir),
            "steps_completed": steps, "unique_training_papers_seen": len(seen_ids),
            "total_optimizer_steps_including_prior_run": prior_steps + steps,
            "epochs_completed": args.epochs if args.full_epoch else None,
            "selected_checkpoint": str(prior_dir / "checkpoint") if prior_dir and before["cross_entropy"] < after["cross_entropy"] else str(checkpoint_dir),
            "selection_rule": "lower validation cross-entropy between starting and final checkpoint",
            "trainable_parameters": config["trainable_parameters"],
            "first_train_batch_loss": trace[0]["loss_before_step"],
            "last_train_batch_loss": trace[-1]["loss_before_step"],
            "batch_losses_are_from_different_examples": True,
            "validation_before": before, "validation_after": after,
            "final_test_evaluated": False,
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            "limitations": config["limitations"],
        }
        write_json(run_dir / "report.json", report)
        print(f"After: {after}", flush=True)
        print(f"Saved checkpoint: {checkpoint_dir}", flush=True)
        return report
    except BaseException as error:
        write_json(run_dir / "failure.json", {"status": "incomplete", "error_type": type(error).__name__, "message": str(error)})
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, help="Reuse a saved prepared-data directory")
    parser.add_argument("--continue-from", type=Path, help="Completed run to continue weights and optimizer from; starts new epochs")
    parser.add_argument("--full-epoch", action="store_true", help="Train on every screened pair per epoch; ignore --max-steps")
    parser.add_argument("--corpus", type=Path, default=ROOT / "work/ml/corpus-v1.json")
    parser.add_argument("--benchmark", type=Path, default=ROOT / "work/ml/benchmark-v1.json")
    parser.add_argument("--output-root", type=Path, default=ROOT / "work/ml/training-runs")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--max-steps", type=int, default=10)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--learning-rate", type=float, default=1e-5)
    parser.add_argument("--temperature", type=float, default=0.05)
    parser.add_argument("--validation-size", type=int, default=32)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    return train(parser.parse_args())


if __name__ == "__main__":
    training_run = main()
