"""Build offline BGE paper embeddings. Run this file from Jupyter with %run.

The immutable corpus already combines title, keywords and available abstract.
This is pretrained inference, not training. No application or database is used.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata
from pathlib import Path
import re
import time
import uuid

import numpy as np
import torch
from huggingface_hub import hf_hub_download
from torch.nn import functional as F
from tqdm.auto import tqdm
from transformers import AutoConfig, AutoModel, AutoTokenizer

from research_ml.data import load_corpus, write_json


PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = "BAAI/bge-small-en-v1.5"
MAX_LENGTH = 512
EMBEDDING_DIM = 384


def encode_batch(texts, tokenizer, model, device):
    """Return final CLS embeddings and a per-text token-length audit."""

    complete_ids = tokenizer(
        texts,
        add_special_tokens=True,
        padding=False,
        truncation=False,
        return_attention_mask=False,
        return_token_type_ids=False,
        verbose=False,
    )["input_ids"]


    inputs = tokenizer(
        texts,
        padding=True,
        truncation=True,
        max_length=MAX_LENGTH,
        return_tensors="pt",
    )
    used_lengths = inputs["attention_mask"].sum(dim=1).tolist()
    inputs = {key: value.to(device) for key, value in inputs.items()}

    with torch.inference_mode():


        outputs = model(**inputs)
        cls_vectors = outputs.last_hidden_state[:, 0, :]
        vectors = F.normalize(cls_vectors.float(), p=2, dim=1)

    array = vectors.cpu().numpy().copy()
    if array.shape != (len(texts), EMBEDDING_DIM):
        raise ValueError(f"Unexpected embedding shape: {array.shape}")
    if not np.isfinite(array).all():
        raise ValueError("An embedding contains NaN or infinity")
    if not np.allclose(np.linalg.norm(array, axis=1), 1.0, atol=1e-5):
        raise ValueError("An embedding is not a nonzero unit vector")

    lengths = [
        {
            "original_tokens": len(ids),
            "encoded_tokens": int(used),
            "truncated": len(ids) > MAX_LENGTH,
        }
        for ids, used in zip(complete_ids, used_lengths)
    ]
    return array, lengths


def build_embeddings(
    corpus_path=PROJECT_ROOT / "work/ml/corpus-v1.json",
    output_root=PROJECT_ROOT / "work/ml/paper-embeddings",
    batch_size=8,
    device="cpu",
    limit=None,
    local_files_only=False,
):
    """Encode all publications by default; --limit is only for smoke tests."""
    if batch_size < 1 or (limit is not None and limit < 1):
        raise ValueError("Batch size and optional limit must be positive")
    if device == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA is unavailable; use --device cpu")

    corpus_path = Path(corpus_path).resolve()
    corpus = load_corpus(corpus_path)
    all_papers = [d for d in corpus["documents"] if d["kind"] == "publications"]
    papers = all_papers if limit is None else all_papers[:limit]
    if not papers:
        raise ValueError("The corpus contains no publications")
    for paper in papers:
        if not paper["text"].strip():
            raise ValueError(f"Empty paper text: {paper['id']}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output_dir = Path(output_root).resolve() / f"bge-{timestamp}-{uuid.uuid4().hex[:8]}"
    output_dir.mkdir(parents=True, exist_ok=False)
    started = time.perf_counter()
    print(f"Corpus: {corpus_path}")
    print(f"Papers selected: {len(papers):,} / {len(all_papers):,}")
    print(f"Device: {device}; batch size: {batch_size}")
    print("Text: existing title + keywords + available abstract; no full body")
    print("Long-input policy: right truncation to 512 tokens, including specials")
    print(f"New output folder: {output_dir}")

    try:


        config_file = Path(hf_hub_download(
            repo_id=MODEL_ID, filename="config.json", local_files_only=local_files_only
        ))
        revision = config_file.parent.name
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError("Cannot determine the model revision for reproducible output")
        config = AutoConfig.from_pretrained(
            MODEL_ID, revision=revision, local_files_only=local_files_only
        )
        if config.hidden_size != EMBEDDING_DIM or config.max_position_embeddings != MAX_LENGTH:
            raise ValueError("The checkpoint configuration does not match BGE-small-en-v1.5")

        tokenizer = AutoTokenizer.from_pretrained(
            MODEL_ID,
            revision=revision,
            local_files_only=local_files_only,
            padding_side="right",
            truncation_side="right",
        )
        model = AutoModel.from_pretrained(
            MODEL_ID,
            revision=revision,
            config=config,
            local_files_only=local_files_only,
            use_safetensors=True,
        ).to(device)
        model.eval()

        embeddings = np.empty((len(papers), EMBEDDING_DIM), dtype=np.float32)
        records = []
        for start in tqdm(range(0, len(papers), batch_size), desc="Encoding papers", unit="batch"):
            batch = papers[start : start + batch_size]
            vectors, lengths = encode_batch(
                [paper["text"] for paper in batch], tokenizer, model, device
            )
            embeddings[start : start + len(batch)] = vectors
            for offset, (paper, audit) in enumerate(zip(batch, lengths)):
                records.append({
                    "row": start + offset,
                    "id": paper["id"],
                    "title": paper["title"],
                    "identifiers": paper["identifiers"],
                    "metadata": paper["metadata"],
                    "text_sha256": hashlib.sha256(paper["text"].encode("utf-8")).hexdigest(),
                    **audit,
                })

        embedding_path = output_dir / "paper_embeddings.npy"
        with embedding_path.open("xb") as file:
            np.save(file, embeddings, allow_pickle=False)
        write_json(output_dir / "papers.json", records)

        report = {
            "status": "complete",
            "created_at_utc": datetime.now(timezone.utc).isoformat(),
            "output_dir": str(output_dir),
            "corpus_path": str(corpus_path),
            "corpus_fingerprint": corpus["fingerprint"],
            "corpus_created_at": corpus.get("created_at"),
            "model_id": MODEL_ID,
            "model_revision": revision,
            "model_weights": "released pretrained checkpoint; no fine-tuning",
            "tokenizer_revision": revision,
            "pooling": "last_hidden_state[:, 0, :] (CLS)",
            "normalization": "L2",
            "document_instruction": "",
            "text_format": "snapshot text: title + keywords + available abstract",
            "max_length_including_special_tokens": MAX_LENGTH,
            "truncation": "right",
            "padding": "right, to longest sequence in each batch; attention mask supplied",
            "available_papers": len(all_papers),
            "encoded_papers": len(papers),
            "partial_corpus": len(papers) < len(all_papers),
            "papers_with_abstract": sum(bool(p["metadata"].get("abstract_available")) for p in papers),
            "papers_truncated": sum(r["truncated"] for r in records),
            "tokens_omitted": sum(r["original_tokens"] - r["encoded_tokens"] for r in records),
            "longest_original_input_tokens": max(r["original_tokens"] for r in records),
            "embedding_shape": list(embeddings.shape),
            "dtype": str(embeddings.dtype),
            "device": device,
            "batch_size": batch_size,
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            "package_versions": {
                name: importlib.metadata.version(name)
                for name in ("torch", "transformers", "numpy", "tqdm", "safetensors", "huggingface-hub")
            },
            "files": {"embeddings": "paper_embeddings.npy", "row_metadata": "papers.json"},
        }

        write_json(output_dir / "manifest.json", report)
        print(f"Saved {len(papers):,} final embeddings; shape {embeddings.shape}")
        print(f"Truncated papers: {report['papers_truncated']:,}")
        print(f"Papers without abstract: {len(papers) - report['papers_with_abstract']:,}")
        print(f"Output: {output_dir}")
        return report
    except BaseException as error:
        write_json(output_dir / "failure.json", {
            "status": "incomplete", "error_type": type(error).__name__, "message": str(error)
        })
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=PROJECT_ROOT / "work/ml/corpus-v1.json")
    parser.add_argument("--output-root", type=Path, default=PROJECT_ROOT / "work/ml/paper-embeddings")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--limit", type=int, help="Smoke-test only: encode the first N papers")
    parser.add_argument("--local-files-only", action="store_true", help="Use cached model files only")
    args = parser.parse_args()
    return build_embeddings(
        corpus_path=args.corpus, output_root=args.output_root,
        batch_size=args.batch_size, device=args.device,
        limit=args.limit, local_files_only=args.local_files_only,
    )


if __name__ == "__main__":
    embedding_run = main()
