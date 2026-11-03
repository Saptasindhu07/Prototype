import copy
from math import log, log2
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from research_ml.baseline import BM25Baseline, tokenize
from research_ml.benchmark import (evaluate_run, run_baseline, validate_benchmark,
                                   review_candidates, save_report)
from research_ml.data import (documents_from_records, fingerprint, load_corpus,
                              make_corpus, validate_filters, write_json)
from research_ml.demo import demo_data
from research_ml.metrics import ranking_metrics
from research_ml.prepare import prepare_benchmark


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.qrels = {"a": 3, "b": 2, "c": 0, "d": 1, "e": 3}

    def test_known_math_and_order_sensitivity(self):
        a = ranking_metrics(["c", "b", "a"], self.qrels, 3)["values"]
        b = ranking_metrics(["a", "b", "c"], self.qrels, 3)["values"]
        ideal = 3 + 3 / log2(3) + 2 / 2
        self.assertAlmostEqual(a["ndcg"], (2 / log2(3) + 3 / 2) / ideal)
        self.assertAlmostEqual(a["precision"], 2 / 3)
        self.assertAlmostEqual(a["recall"], 2 / 3)
        self.assertEqual(a["mrr"], .5)
        self.assertGreater(b["ndcg"], a["ndcg"])
        self.assertEqual(a["recall"], b["recall"])
        self.assertEqual(ranking_metrics(["a", "e", "b"], self.qrels, 3)["values"]["ndcg"], 1)

    def test_short_empty_and_all_zero_rankings(self):
        result = ranking_metrics(["a"], self.qrels, 5)["values"]
        self.assertEqual(result["precision"], .2)
        self.assertEqual(result["recall"], 1 / 3)
        self.assertEqual(ranking_metrics([], self.qrels, 3)["values"]["ndcg"], 0)
        self.assertFalse(ranking_metrics(["a"], {"a": 0}, 3)["scorable"])

    def test_unknown_is_not_zero_and_cutoff_specific_coverage(self):
        result = ranking_metrics(["a", "unreviewed"], {"a": 3}, 2, "pooled")
        self.assertFalse(result["scorable"])
        self.assertIsNone(result["values"]["precision"])
        self.assertEqual(result["judged_coverage"], .5)
        self.assertTrue(ranking_metrics(["a", "unreviewed"], {"a": 3}, 1, "pooled")["scorable"])
        self.assertFalse(ranking_metrics(["a"], {}, 1, "pending")["scorable"])

    def test_invalid_grades_duplicates_and_cutoffs(self):
        for ranked, grades, k in [(["a", "a"], self.qrels, 3), (["a"], {"a": True}, 1),
                                   (["a"], {"a": 4}, 1), (["a"], self.qrels, 0)]:
            with self.assertRaises(ValueError):
                ranking_metrics(ranked, grades, k)


class BaselineTests(unittest.TestCase):
    def setUp(self):
        self.corpus, self.benchmark = demo_data()
        self.index = BM25Baseline(self.corpus["documents"])

    def test_tokenizer_preserves_technical_terms(self):
        self.assertEqual(tokenize("C++ and IL-6 for β-catenin in C#"), ["c++", "il-6", "β-catenin", "c#"])

    def test_independent_bm25_formula(self):
        docs = [{"id": "a", "kind": "publications", "title": "", "text": "alpha alpha", "identifiers": {}, "metadata": {}},
                {"id": "b", "kind": "publications", "title": "", "text": "beta", "identifiers": {}, "metadata": {}}]
        score = BM25Baseline(docs).search("alpha")[0]["score"]
        expected = log(1 + 1.5 / 1.5) * 2 * 2.2 / (2 + 1.2 * (.25 + .75 * 2 / 1.5))
        self.assertAlmostEqual(score, expected)

    def test_exact_identifiers_and_missing_identifier(self):
        self.assertEqual(self.index.search("HTTPS://DOI.ORG/10.9999/EXAMPLE-P1")[0]["id"], "publication:p1")
        self.assertEqual(self.index.search("A1001", "researchers")[0]["id"], "researcher:r1")
        self.assertEqual(self.index.search("10.9999/missing"), [])

    def test_filters_apply_before_top_k(self):
        hits = self.index.search("brain tumour segmentation", filters={"year_from": 2025}, k=1)
        self.assertEqual([hit["id"] for hit in hits], ["publication:p5"])
        self.assertEqual(self.index.search("A1001", "researchers", {"department": "Zoology"}), [])
        with self.assertRaises(ValueError):
            self.index.search("marine", "researchers", {"year_from": 2020})

    def test_repeat_query_invariance_and_deterministic_ties(self):
        self.assertEqual(self.index.search("brain"), self.index.search("brain brain"))
        self.assertEqual(self.index.search("the and"), [])
        for k1, b in [(0, .75), (1.2, 2), (float("nan"), .75)]:
            with self.assertRaises(ValueError):
                BM25Baseline(self.corpus["documents"], k1=k1, b=b)


class DataTests(unittest.TestCase):
    def test_doi_dedup_and_verified_author_link(self):
        people = [{"_id": "r", "name": "Same Name", "affiliations": [{"department": "Physics"}]}]
        papers = [{"_id": "p1", "title": "Topic", "externalIds": {"doi": "https://doi.org/10.1234/ABC"},
                   "authors": [{"name": "Same Name", "researcherId": "r"}]},
                  {"_id": "p2", "title": "Topic", "abstract": "Full abstract", "externalIds": {"doi": "10.1234/abc"},
                   "authors": [{"name": "Same Name"}]},
                  {"_id": "p3", "title": "Unlinked topic", "authors": [{"name": "Same Name"}]}]
        original = copy.deepcopy(papers)
        docs = documents_from_records(papers, people)
        self.assertEqual(len(docs), 3)
        researcher = next(doc for doc in docs if doc["kind"] == "researchers")
        self.assertEqual(researcher["metadata"]["publication_ids"], ["publication:p2"])
        self.assertNotIn("Unlinked topic", researcher["text"])
        self.assertEqual(papers, original)

    def test_fingerprint_and_no_overwrite(self):
        corpus, _ = demo_data()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "corpus.json"
            write_json(path, corpus)
            self.assertEqual(load_corpus(path)["fingerprint"], corpus["fingerprint"])
            with self.assertRaises(FileExistsError):
                write_json(path, corpus)
            changed = copy.deepcopy(corpus)
            changed["documents"][0]["text"] += " tampered"
            other = Path(folder) / "changed.json"
            write_json(other, changed)
            with self.assertRaises(ValueError):
                load_corpus(other)

    def test_invalid_filters(self):
        for filters in [{"year_from": True}, {"year_from": 2025, "year_to": 2000}, {"limit": 4}]:
            with self.assertRaises(ValueError):
                validate_filters("publications", filters)


class ProtocolTests(unittest.TestCase):
    def setUp(self):
        self.corpus, self.benchmark = demo_data()
        self.run = run_baseline(self.corpus, self.benchmark, depth=10)

    def test_full_demo_and_pending_real_style_suite(self):
        report = evaluate_run(self.run, self.corpus, self.benchmark)
        self.assertEqual(report["statuses"], {"scored": 7})
        starter = prepare_benchmark(self.corpus)
        run = run_baseline(self.corpus, starter, split="all")
        report = evaluate_run(run, self.corpus, starter)
        pending = [row for row in report["queries"] if row["status"] == "pending"]
        self.assertEqual(len(pending), 16)
        self.assertTrue(all(row["metrics"] == {} for row in pending))
        pool = review_candidates(run, self.corpus, starter)
        self.assertTrue(all(row["grade"] is None for row in pool["candidates"]))

    def test_failure_is_zero_not_silently_dropped(self):
        self.run["results"][0].update(status="error", ranking=[], error_type="TimeoutError")
        report = evaluate_run(self.run, self.corpus, self.benchmark)
        self.assertEqual(report["statuses"]["error"], 1)
        self.assertEqual(report["queries"][0]["metrics"]["ndcg@3"], 0)
        bucket = report["summaries"]["dev/publications/ranking/complete/synthetic"]
        self.assertEqual(bucket["metrics"]["ndcg@3"]["n"], 3)

    def test_missing_and_duplicate_query_rejected(self):
        for results in [self.run["results"][:-1], self.run["results"] + [self.run["results"][0]]]:
            broken = {**self.run, "results": results}
            with self.assertRaises(ValueError):
                evaluate_run(broken, self.corpus, self.benchmark)

    def test_snapshot_and_benchmark_drift_rejected(self):
        for key in ["corpus_fingerprint", "benchmark_fingerprint"]:
            broken = {**self.run, key: "wrong"}
            with self.assertRaises(ValueError):
                evaluate_run(broken, self.corpus, self.benchmark)

    def test_filter_violation_duplicate_and_unknown_hit_rejected(self):
        for hit in [{"id": "missing", "score": 1}, {"id": "researcher:r1", "score": 1}]:
            broken = copy.deepcopy(self.run)
            broken["results"][0]["ranking"] = [hit]
            with self.assertRaises(ValueError):
                evaluate_run(broken, self.corpus, self.benchmark)
        broken = copy.deepcopy(self.run)
        broken["results"][0]["ranking"] *= 2
        with self.assertRaises(ValueError):
            evaluate_run(broken, self.corpus, self.benchmark)

    def test_group_leakage_and_invalid_cutoff_rejected(self):
        self.benchmark["queries"][1].update(group=self.benchmark["queries"][0]["group"], split="test")
        with self.assertRaises(ValueError):
            validate_benchmark(self.benchmark, self.corpus)
        corpus, benchmark = demo_data()
        with self.assertRaises(ValueError):
            evaluate_run(self.run, corpus, benchmark, [11])

    def test_pooled_metrics_not_mixed_with_complete_metrics(self):
        query = self.benchmark["queries"][0]
        query["judgment_scope"] = "pooled"
        query["qrels"] = {doc["id"]: query["qrels"].get(doc["id"], 0)
                          for doc in self.corpus["documents"] if doc["kind"] == "publications"}
        run = run_baseline(self.corpus, self.benchmark)
        row = evaluate_run(run, self.corpus, self.benchmark)["queries"][0]
        self.assertIn("known_recall@3", row["metrics"])
        self.assertIn("pooled_ndcg@3", row["metrics"])
        self.assertNotIn("recall@3", row["metrics"])

    def test_oracle_labels_cannot_be_changed_to_favor_model(self):
        starter = prepare_benchmark(self.corpus)
        lookup = next(q for q in starter["queries"] if q["task"] == "lookup")
        lookup["qrels"] = {"publication:p3": 3}
        with self.assertRaises(ValueError):
            validate_benchmark(starter, self.corpus)


if __name__ == "__main__":
    unittest.main()
