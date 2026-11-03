"""Conservative offline screening for the notebook's title/content proxy splits.

No training, benchmark evaluation, database access, or file writes occur here.
Near-title matches are review candidates, not confirmed duplicates. This screen
cannot certify absence of semantic overlap or unrecognized paper versions.
"""

from collections import defaultdict
from difflib import SequenceMatcher
import json
from pathlib import Path
import re


def audit_pair_splits(train, validation, proxy_test, groups, benchmark_path):
    """Return filtered copies of splits and an audit report; preserve inputs."""
    splits = {"train": train, "validation": validation, "proxy_test": proxy_test}
    entries = [(name, pair) for name, pairs in splits.items() for pair in pairs]
    ids = [pair["positive_paper_id"] for _, pair in entries]
    if len(ids) != len(set(ids)):
        raise ValueError("Repeated paper IDs within or between splits")
    group_ids = [{pair["positive_paper_id"] for pair in group} for group in groups]
    grouped_ids = [paper_id for group in group_ids for paper_id in group]
    if len(grouped_ids) != len(set(grouped_ids)):
        raise ValueError("A paper belongs to multiple duplicate groups")
    if not set(ids).issubset(set(grouped_ids)):
        raise ValueError("Some split papers are missing from the duplicate groups")

    benchmark = json.loads(Path(benchmark_path).read_text(encoding="utf-8"))
    queries = benchmark["queries"]
    known_targets = {
        paper_id
        for query in queries
        for paper_id in query.get("qrels", {})
        if paper_id.startswith("publication:")
    }
    direct_targets = set(ids) & known_targets


    reserved = set()
    for group in group_ids:
        if group & known_targets:
            reserved.update(group)


    title_index = defaultdict(list)
    title_entries = []
    near_matches = []
    for split_name, pair in entries:
        paper_id = pair["positive_paper_id"]
        if paper_id in reserved:
            continue
        title = " ".join(re.findall(r"\w+", pair["query"].casefold()))
        words = title.split()
        keys = set(zip(words, words[1:]))
        if not keys and title:
            keys = {(title,)}
        candidates = {index for key in keys for index in title_index[key]}
        for index in sorted(candidates):
            other_split, other_pair, other_title = title_entries[index]
            if other_split == split_name:
                continue
            if min(len(title), len(other_title)) / max(len(title), len(other_title)) < 0.8:
                continue
            score = SequenceMatcher(None, title, other_title, autojunk=False).ratio()
            if score >= 0.90:
                near_matches.append({
                    "left_id": other_pair["positive_paper_id"],
                    "right_id": paper_id,
                    "left_split": other_split,
                    "right_split": split_name,
                    "left_title": other_pair["query"],
                    "right_title": pair["query"],
                    "character_similarity": score,
                })
        index = len(title_entries)
        title_entries.append((split_name, pair, title))
        for key in keys:
            title_index[key].append(index)

    flagged = known_targets | {
        match[key] for match in near_matches for key in ("left_id", "right_id")
    }
    for group in group_ids:
        if group & flagged:
            reserved.update(group)

    cleaned = {
        name: [pair for pair in pairs if pair["positive_paper_id"] not in reserved]
        for name, pairs in splits.items()
    }
    for name, pairs in cleaned.items():
        if not pairs:
            raise ValueError(f"Screening left the {name} split empty")
    for field in ("positive_paper_id", "query", "positive_text"):
        sets = [
            {" ".join(pair[field].casefold().split()) for pair in pairs}
            for pairs in cleaned.values()
        ]
        if any(sets[a] & sets[b] for a, b in ((0, 1), (0, 2), (1, 2))):
            raise ValueError(f"Exact cross-split overlap remains in {field}")

    report = {
        "status": "screened_not_semantically_certified",
        "benchmark_known_target_ids_in_candidates": sorted(direct_targets),
        "near_title_cross_split_candidates": near_matches,
        "reserved_paper_ids": sorted(set(ids) & reserved),
        "counts_before": {name: len(pairs) for name, pairs in splits.items()},
        "counts_after": {name: len(pairs) for name, pairs in cleaned.items()},
        "pending_benchmark_ranking_queries": sum(
            query["task"] == "ranking" and not query.get("qrels") for query in queries
        ),
        "limitations": [
            "Near-title screening is heuristic and does not prove duplication.",
            "Semantic paraphrases and other paper versions may remain undetected.",
            "Benchmark information-need overlap still requires review.",
            "This proxy split is not a human-judged search-quality benchmark.",
        ],
    }
    return cleaned, report
