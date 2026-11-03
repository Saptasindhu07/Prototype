"""Versioned queries, baseline runs, honest reports, and annotation candidates."""

from collections import Counter, defaultdict
from math import ceil, isfinite
from pathlib import Path
from statistics import mean, median
from time import perf_counter
from .baseline import BM25Baseline
from .data import (KINDS, eligible, fingerprint, now, normalize_identifier,
                   validate_filters, write_json)
from .metrics import ranking_metrics


def validate_benchmark(benchmark, corpus):
    if benchmark.get("schema_version") != 1 or benchmark.get("corpus_fingerprint") != corpus["fingerprint"]:
        raise ValueError("Benchmark schema or corpus fingerprint mismatch")
    if not benchmark.get("queries"):
        raise ValueError("Benchmark has no queries")
    documents = {doc["id"]: doc for doc in corpus["documents"]}
    ids, groups = set(), {}
    for query in benchmark["queries"]:
        qid = query.get("id")
        if not isinstance(qid, str) or not qid or qid in ids:
            raise ValueError("Missing or duplicate query ID")
        ids.add(qid)
        if query.get("kind") not in KINDS or query.get("split") not in {"dev", "test"}:
            raise ValueError("Invalid query kind or split")
        group = query.get("group")
        if not isinstance(group, str) or not group:
            raise ValueError("Each query needs a leakage-prevention group")
        if group in groups and groups[group] != query["split"]:
            raise ValueError("Related query group crosses dev/test splits")
        groups[group] = query["split"]
        if not isinstance(query.get("text"), str) or not query["text"].strip():
            raise ValueError("Empty query text")
        validate_filters(query["kind"], query.get("filters", {}))
        task, scope = query.get("task"), query.get("judgment_scope")
        if task not in {"ranking", "lookup", "no_match"} or scope not in {"complete", "pooled", "pending"}:
            raise ValueError("Invalid evaluation task or judgment scope")
        source = query.get("judgment_source")
        if source not in {"pending", "human", "synthetic", "rule_based"}:
            raise ValueError("Unknown judgment source")
        qrels = query.get("qrels")
        if not isinstance(qrels, dict):
            raise ValueError("qrels must map document IDs to grades")
        for doc_id, grade in qrels.items():
            if type(grade) is not int or not 0 <= grade <= 3:
                raise ValueError("Grades must be integers from 0 to 3")
            if doc_id not in documents or not eligible(documents[doc_id], query["kind"], query.get("filters", {})):
                raise ValueError("Judgment references an unknown or ineligible document")
        if scope == "pending":
            if qrels or source != "pending" or task != "ranking":
                raise ValueError("Pending topics must have empty qrels and pending source")
        else:
            if source == "pending":
                raise ValueError("Reviewed queries need judgment provenance")
            if task != "no_match" and not any(grade >= 2 for grade in qrels.values()):
                raise ValueError("Judged ranking/lookup requires at least one relevant document")
            if task == "no_match" and (scope != "complete" or any(qrels.values())):
                raise ValueError("No-match needs complete judgments and no positive grades")
            if task == "lookup" and scope != "complete":
                raise ValueError("Known-item lookups require complete target judgments")
        if source == "human" and (not query.get("assessor") or not query.get("judgment_notes")):
            raise ValueError("Human judgments require assessor and judgment_notes")
        if source == "synthetic" and corpus["source"] != "synthetic":
            raise ValueError("Synthetic judgments cannot grade a real corpus")
        if source == "rule_based":

            oracle = query.get("oracle", {})
            if scope != "complete" or task not in {"lookup", "no_match"} or oracle.get("type") != "exact_identifier":
                raise ValueError("Rule-based labels are limited to exact-identifier checks")
            value = normalize_identifier(query["text"])
            expected = {doc["id"]: 3 for doc in documents.values()
                        if eligible(doc, query["kind"], query.get("filters", {})) and
                        value in [normalize_identifier(v) for v in doc["identifiers"].values()]}
            if expected != qrels or (task == "no_match") != (not expected):
                raise ValueError("Identifier oracle does not match corpus and qrels")
    return benchmark


def select_queries(benchmark, split):
    if split not in {"dev", "test", "all"}:
        raise ValueError("Split must be dev, test or all")
    queries = [q for q in benchmark["queries"] if split == "all" or q["split"] == split]
    if not queries:
        raise ValueError("Selected split has no queries")
    return queries


def run_baseline(corpus, benchmark, split="dev", depth=50, k1=1.2, b=0.75):
    validate_benchmark(benchmark, corpus)
    if type(depth) is not int or depth < 1:
        raise ValueError("Depth must be a positive integer")
    queries = select_queries(benchmark, split)
    start = perf_counter()
    baseline = BM25Baseline(corpus["documents"], k1=k1, b=b)
    build_ms = (perf_counter() - start) * 1000
    rows = []
    for query in queries:
        start = perf_counter()
        try:
            ranking = baseline.search(query["text"], query["kind"], query.get("filters", {}), depth)
            row = {"query_id": query["id"], "status": "ok", "ranking": ranking}
        except Exception as exc:

            row = {"query_id": query["id"], "status": "error", "ranking": [], "error_type": type(exc).__name__}
        row["latency_ms"] = (perf_counter() - start) * 1000
        rows.append(row)
    return {"schema_version": 1, "created_at": now(), "engine": baseline.name,
            "configuration": baseline.configuration, "corpus_fingerprint": corpus["fingerprint"],
            "benchmark_fingerprint": fingerprint(benchmark), "split": split, "depth": depth,
            "index_build_ms": build_ms, "latency_scope": "in-process search only; excludes index construction and database export",
            "results": rows}


def validate_run(run, corpus, benchmark):
    validate_benchmark(benchmark, corpus)
    if run.get("schema_version") != 1 or run.get("corpus_fingerprint") != corpus["fingerprint"]:
        raise ValueError("Run schema or corpus mismatch")
    if run.get("benchmark_fingerprint") != fingerprint(benchmark):
        raise ValueError("Benchmark changed since this run; regenerate rankings")
    if type(run.get("depth")) is not int or run["depth"] < 1:
        raise ValueError("Run depth must be positive")
    queries = {q["id"]: q for q in select_queries(benchmark, run.get("split"))}
    documents = {doc["id"]: doc for doc in corpus["documents"]}
    seen = set()
    for row in run.get("results", []):
        qid = row.get("query_id")
        if qid not in queries or qid in seen:
            raise ValueError("Unexpected or duplicate query in run")
        seen.add(qid)
        if row.get("status") not in {"ok", "error"}:
            raise ValueError("Run query status must be ok or error")
        latency = row.get("latency_ms")
        if isinstance(latency, bool) or not isinstance(latency, (int, float)) or not isfinite(latency) or latency < 0:
            raise ValueError("Invalid query latency")
        ranking = row.get("ranking")
        if not isinstance(ranking, list) or len(ranking) > run["depth"]:
            raise ValueError("Invalid ranking or depth exceeded")
        if row["status"] == "error" and ranking:
            raise ValueError("Failed query cannot contain successful results")
        ids = set()
        for hit in ranking:
            doc_id = hit.get("id")
            if doc_id not in documents or doc_id in ids:
                raise ValueError("Unknown or duplicate returned document")
            ids.add(doc_id)
            query = queries[qid]
            if not eligible(documents[doc_id], query["kind"], query.get("filters", {})):
                raise ValueError("Returned document violates query filters or kind")
            score = hit.get("score")
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not isfinite(score):
                raise ValueError("Scores must be finite numbers")
    if seen != set(queries):
        raise ValueError("Missing query outcomes; failures must be explicitly recorded")
    return queries


def evaluate_run(run, corpus, benchmark, cutoffs=(3, 5, 10)):
    queries = validate_run(run, corpus, benchmark)
    cutoffs = sorted(set(cutoffs))
    if not cutoffs or any(type(k) is not int or k < 1 or k > run["depth"] for k in cutoffs):
        raise ValueError("Every cutoff must be positive and <= recorded retrieval depth")
    rows, buckets = [], defaultdict(list)
    for result in run["results"]:
        query = queries[result["query_id"]]
        ranked = [hit["id"] for hit in result["ranking"]]
        metrics, coverage, unknown = {}, {}, set()
        scope, task = query["judgment_scope"], query["task"]
        if scope != "pending":
            for k in cutoffs:
                if task == "lookup":
                    positives = {key for key, grade in query["qrels"].items() if grade >= 2}
                    metrics[f"hit@{k}"] = float(bool(set(ranked[:k]) & positives))
                    metrics[f"mrr@{k}"] = next((1 / i for i, doc_id in enumerate(ranked[:k], 1) if doc_id in positives), 0.0)
                elif task == "no_match":
                    metrics[f"correct_empty@{k}"] = float(result["status"] == "ok" and not ranked[:k])
                else:
                    evaluated = ranking_metrics(ranked, query["qrels"], k, scope)
                    coverage[str(k)] = evaluated["judged_coverage"]
                    unknown.update(evaluated["unjudged_ids"])
                    for name, value in evaluated["values"].items():
                        prefix = "known_" if scope == "pooled" and name == "recall" else "pooled_" if scope == "pooled" else ""
                        metrics[f"{prefix}{name}@{k}"] = 0.0 if result["status"] == "error" else value
        state = "error" if result["status"] == "error" else "pending" if scope == "pending" else "needs_judgments" if unknown else "scored"
        row = {"query_id": query["id"], "text": query["text"], "kind": query["kind"],
               "split": query["split"], "task": task, "judgment_scope": scope,
               "judgment_source": query["judgment_source"], "status": state,
               "returned": len(ranked), "latency_ms": result["latency_ms"],
               "metrics": metrics, "judged_coverage": coverage, "unjudged_ids": sorted(unknown)}
        rows.append(row)
        bucket = "/".join([query["split"], query["kind"], task, scope, query["judgment_source"]])
        buckets[bucket].append(row)
    summaries = {}
    for key, members in sorted(buckets.items()):
        names = sorted({name for row in members for name in row["metrics"]})
        summaries[key] = {"queries": len(members), "statuses": dict(Counter(r["status"] for r in members)),
                          "metrics": {name: {"mean": mean(values) if values else None, "n": len(values)}
                                      for name in names
                                      for values in [[r["metrics"][name] for r in members if r["metrics"].get(name) is not None]]}}
    times = sorted(row["latency_ms"] for row in rows)
    return {"schema_version": 1, "created_at": now(), "engine": run["engine"],
            "corpus_fingerprint": corpus["fingerprint"], "benchmark_fingerprint": fingerprint(benchmark),
            "run_fingerprint": fingerprint(run), "corpus_source": corpus["source"],
            "cutoffs": cutoffs, "query_count": len(rows), "statuses": dict(Counter(r["status"] for r in rows)),
            "latency_ms": {"median": median(times), "p95": times[ceil(.95 * len(times)) - 1], "scope": run["latency_scope"]},
            "protocol": {"gain": "linear", "relevant_grade_min": 2, "precision_denominator": "k, including missing slots",
                         "unjudged": "pending: no quality scores; pooled: no score at a cutoff with unjudged hits",
                         "failures": "reported explicitly; evaluable query failures contribute zero",
                         "aggregation": "macro per split/kind/task/scope/source; n records denominator",
                         "limitation": "Exact-identifier checks are correctness checks, not semantic relevance evidence."},
            "summaries": summaries, "queries": rows}


def review_candidates(run, corpus, benchmark):
    queries = validate_run(run, corpus, benchmark)
    documents = {doc["id"]: doc for doc in corpus["documents"]}
    candidates = []
    for row in run["results"]:
        query = queries[row["query_id"]]
        if query["task"] != "ranking":
            continue
        for hit in row["ranking"]:
            doc = documents[hit["id"]]
            candidates.append({"query_id": query["id"], "query": query["text"], "split": query["split"],
                               "document_id": doc["id"], "title": doc["title"], "text": doc["text"],
                               "metadata": doc["metadata"], "grade": query["qrels"].get(doc["id"]),
                               "reason": "", "assessor": ""})

    candidates.sort(key=lambda item: fingerprint([item["query_id"], item["document_id"]]))
    return {"schema_version": 1, "corpus_fingerprint": corpus["fingerprint"],
            "benchmark_fingerprint": fingerprint(benchmark), "status": "candidate_pool_not_ground_truth",
            "note": "Combine pools from multiple retrievers/manual search before judging. Null grades are unknown, not zero.",
            "candidates": candidates}


def save_report(directory, run, report, review):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    write_json(directory / "run.json", run)
    write_json(directory / "report.json", report)
    write_json(directory / "review-candidates.json", review)
    lines = [f"# {report['engine']}", "", f"Corpus: `{report['corpus_fingerprint']}`",
             f"Queries: {report['query_count']}; statuses: {report['statuses']}", "",
             "Identifier checks measure exact lookup correctness, not semantic search quality.",
             "Pending topics have no relevance score. Pooled metrics cover known judgments only.",
             "Failures are reported and contribute zero where evaluable.", "",
             f"Search latency: median {report['latency_ms']['median']:.2f} ms; p95 {report['latency_ms']['p95']:.2f} ms.",
             report["latency_ms"]["scope"], "", "| Group | Metric | Mean | Scored queries |",
             "| --- | --- | ---: | ---: |"]
    for group, summary in report["summaries"].items():
        for metric, value in summary["metrics"].items():
            score = "pending" if value["mean"] is None else f"{value['mean']:.4f}"
            lines.append(f"| {group} | {metric} | {score} | {value['n']} / {summary['queries']} |")
    (directory / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
