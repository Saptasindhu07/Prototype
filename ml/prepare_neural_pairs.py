"""Reproduce the notebook's weak title/content pairs and screened group split."""

from collections import defaultdict
from pathlib import Path
import random

from audit_pair_splits import audit_pair_splits
from research_ml.data import fingerprint, load_corpus, read_json, write_json


def prepare_pairs(corpus_path, benchmark_path, output_dir, seed=42):
    corpus = load_corpus(corpus_path)
    benchmark = read_json(benchmark_path)
    if benchmark["corpus_fingerprint"] != corpus["fingerprint"]:
        raise ValueError("Benchmark and corpus fingerprints differ")
    pairs = []
    for paper in corpus["documents"]:
        if paper["kind"] != "publications" or not paper["metadata"].get("abstract_available"):
            continue
        title = paper["title"]
        prefix = title + "\n"
        if not title.strip() or not paper["text"].startswith(prefix):
            raise ValueError(f"Unexpected paper text format: {paper['id']}")
        content = paper["text"][len(prefix):].strip()
        if content:
            pairs.append({
                "query": title.strip(), "positive_text": content,
                "positive_paper_id": paper["id"],
                "label_source": "same_paper_title_content", "reviewed": False,
            })
    pairs.sort(key=lambda pair: pair["positive_paper_id"])
    parent = list(range(len(pairs)))

    def find(index):
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    seen = {}
    for index, pair in enumerate(pairs):
        for field in ("query", "positive_text"):
            key = (field, " ".join(pair[field].casefold().split()))
            if key in seen:
                parent[find(index)] = find(seen[key])
            else:
                seen[key] = index
    groups = defaultdict(list)
    for index, pair in enumerate(pairs):
        groups[find(index)].append(pair)
    group_list = list(groups.values())
    for group in group_list:
        group_id = min(pair["positive_paper_id"] for pair in group)
        for pair in group:
            pair["group_id"] = group_id
    random.Random(seed).shuffle(group_list)
    first, second = int(0.8 * len(group_list)), int(0.9 * len(group_list))
    initial_splits = [
        [pair for group in part for pair in group]
        for part in (group_list[:first], group_list[first:second], group_list[second:])
    ]
    print("Screening benchmark IDs and near-title overlap...", flush=True)
    splits, audit = audit_pair_splits(*initial_splits, group_list, benchmark_path)
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=False)
    for name, rows in splits.items():
        write_json(output_dir / f"{name}.json", rows)
    write_json(output_dir / "audit.json", audit)
    manifest = {
        "schema_version": 1, "corpus_fingerprint": corpus["fingerprint"],
        "benchmark_fingerprint": fingerprint(benchmark), "seed": seed,
        "counts": {name: len(rows) for name, rows in splits.items()},
        "split_fingerprints": {name: fingerprint(rows) for name, rows in splits.items()},
        "labels": "weak title-to-own-content association, not reviewed relevance",
        "audit_status": audit["status"], "limitations": audit["limitations"],
    }
    write_json(output_dir / "manifest.json", manifest)
    return manifest


def load_training_splits(data_dir):
    """Do not open proxy_test.json during training or validation."""
    data_dir = Path(data_dir)
    manifest = read_json(data_dir / "manifest.json")
    splits = {name: read_json(data_dir / f"{name}.json") for name in ("train", "validation")}
    for name, rows in splits.items():
        if fingerprint(rows) != manifest["split_fingerprints"][name]:
            raise ValueError(f"Changed or corrupted {name} pairs")
        if not rows or any(not row["query"].strip() or not row["positive_text"].strip() for row in rows):
            raise ValueError(f"Empty text in {name} pairs")
    train_groups = {row["group_id"] for row in splits["train"]}
    if train_groups & {row["group_id"] for row in splits["validation"]}:
        raise ValueError("Duplicate group crosses train and validation")
    return splits, manifest
