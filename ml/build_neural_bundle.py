"""Package a selected encoder and its matching immutable full-corpus index."""
import argparse
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import shutil
import uuid

import numpy as np
import torch
from tqdm.auto import tqdm
from transformers import AutoModel, AutoTokenizer

from embed_papers import encode_batch
from research_ml.data import fingerprint, load_corpus, read_json, write_json
from train_search import QUERY_INSTRUCTION

ROOT = Path(__file__).resolve().parent.parent


def file_hash(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def build_bundle(training_run, corpus_path, output_root, batch_size=8, threads=4):
    report = read_json(Path(training_run) / "report.json")
    config = read_json(Path(training_run) / "config.json")
    corpus = load_corpus(corpus_path)
    if report["status"] != "complete" or corpus["fingerprint"] != config["data_manifest"]["corpus_fingerprint"]:
        raise ValueError("Need a completed run and its original corpus")
    checkpoint = Path(report.get("selected_checkpoint", report["checkpoint_dir"]))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = Path(output_root).resolve() / f"bge-bundle-{stamp}-{uuid.uuid4().hex[:8]}"
    encoder = output / "encoder"
    encoder.mkdir(parents=True, exist_ok=False)
    print(f"Bundle: {output}", flush=True)
    try:
        allowed = {"config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt", "added_tokens.json"}
        for source in checkpoint.iterdir():
            if source.is_file() and (source.name in allowed or source.suffix == ".safetensors"):
                shutil.copy2(source, encoder / source.name)
        hashes = {p.name: file_hash(p) for p in sorted(encoder.iterdir())}
        if "model.safetensors" not in hashes or "config.json" not in hashes:
            raise ValueError("Incomplete encoder checkpoint")
        torch.set_num_threads(threads)
        tokenizer = AutoTokenizer.from_pretrained(encoder, local_files_only=True, padding_side="right", truncation_side="right")
        model = AutoModel.from_pretrained(encoder, local_files_only=True, use_safetensors=True).eval()
        papers = [p for p in corpus["documents"] if p["kind"] == "publications"]
        vectors = np.empty((len(papers), 384), dtype=np.float32)
        rows = []
        for start in tqdm(range(0, len(papers), batch_size), desc="Building selected-model index", unit="batch"):
            batch = papers[start:start + batch_size]
            encoded, lengths = encode_batch([p["text"] for p in batch], tokenizer, model, "cpu")
            vectors[start:start + len(batch)] = encoded
            for paper, audit in zip(batch, lengths):
                rows.append({"id": paper["id"], "title": paper["title"],
                             "identifiers": paper["identifiers"], "metadata": paper["metadata"], **audit})
        with (output / "embeddings.npy").open("xb") as stream:
            np.save(stream, vectors, allow_pickle=False)
        write_json(output / "documents.json", rows)
        manifest = {
            "schema_version": 1, "status": "complete", "model_id": "BAAI/bge-small-en-v1.5",
            "model_fingerprint": fingerprint(hashes), "encoder_files": hashes,
            "source_training_run": str(Path(training_run).resolve()), "selected_checkpoint": str(checkpoint),
            "corpus_fingerprint": corpus["fingerprint"], "shape": list(vectors.shape), "dtype": "float32",
            "pooling": "final CLS", "normalization": "L2", "max_length": 512,
            "query_instruction": QUERY_INSTRUCTION, "document_instruction": "",
            "document_text": "title + keywords + available abstract",
            "papers_truncated": sum(row["truncated"] for row in rows),
            "files": {name: file_hash(output / name) for name in ("embeddings.npy", "documents.json")},
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
        }
        write_json(output / "manifest.json", manifest)
        print(f"Ready: {output}; {vectors.shape}", flush=True)
        return output
    except BaseException as error:
        write_json(output / "failure.json", {"status": "incomplete", "error_type": type(error).__name__, "message": str(error)})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--training-run", type=Path, required=True)
    parser.add_argument("--corpus", type=Path, default=ROOT / "work/ml/corpus-v1.json")
    parser.add_argument("--output-root", type=Path, default=ROOT / "work/ml/bundles")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.batch_size < 1 or args.threads < 1:
        parser.error("batch-size and threads must be positive")
    build_bundle(args.training_run, args.corpus, args.output_root, args.batch_size, args.threads)
