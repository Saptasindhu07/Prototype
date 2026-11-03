"""Ranking metrics, explicitly separating unknown judgments from grade zero."""

from math import log2


def dcg(grades):
    """Linear gain: grade / log2(rank + 1), matching the teaching example."""
    return sum(grade / log2(rank + 1) for rank, grade in enumerate(grades, 1))


def ranking_metrics(ranked_ids, qrels, k, scope="complete", threshold=2):
    if type(k) is not int or k < 1 or scope not in {"complete", "pooled", "pending"}:
        raise ValueError("Invalid cutoff or judgment scope")
    if len(set(ranked_ids)) != len(ranked_ids):
        raise ValueError("Duplicate IDs cannot earn relevance credit")
    if any(type(grade) is not int or not 0 <= grade <= 3 for grade in qrels.values()):
        raise ValueError("Relevance grades must be integers from 0 to 3")
    top = ranked_ids[:k]
    unknown = [doc_id for doc_id in top if doc_id not in qrels]
    coverage = 1.0 if scope == "complete" or not top else (len(top) - len(unknown)) / len(top)
    relevant = {doc_id for doc_id, grade in qrels.items() if grade >= threshold}
    values = {"precision": None, "recall": None, "ndcg": None, "mrr": None}
    if scope == "pending" or not relevant or (scope == "pooled" and unknown):
        return {"values": values, "judged_coverage": coverage,
                "unjudged_ids": unknown, "scorable": False}
    hits = len(set(top) & relevant)
    ideal = dcg(sorted(qrels.values(), reverse=True)[:k])
    values.update(precision=hits / k, recall=hits / len(relevant),
                  ndcg=dcg([qrels.get(doc_id, 0) for doc_id in top]) / ideal if ideal else None,
                  mrr=next((1 / rank for rank, doc_id in enumerate(top, 1) if doc_id in relevant), 0.0))
    return {"values": values, "judged_coverage": coverage,
            "unjudged_ids": unknown if scope != "complete" else [], "scorable": True}
