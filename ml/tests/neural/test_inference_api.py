"""Neural-service contract tests; no model downloads or MongoDB writes."""
from pathlib import Path
import sys
import unittest
import json
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from fastapi.testclient import TestClient
from inference_api import create_app, eligible, Filters, SearchEngine, QUERY_INSTRUCTION


class FakeEngine:
    version = "1234567890abcdef"
    def search(self, request):
        return {"hits": [], "query": request.query, "limit": request.limit,
                "filters": request.filters.model_dump(exclude_none=True)}


class InferenceContractTests(unittest.TestCase):
    def test_offline_and_validation(self):
        with TestClient(create_app(engine_factory=lambda: None)) as client:
            self.assertFalse(client.get("/health").json()["ready"])
            self.assertEqual(client.post("/search", json={"query": "MRI"}).status_code, 503)
        with TestClient(create_app(engine_factory=FakeEngine)) as client:
            self.assertTrue(client.get("/health").json()["ready"])
            for body in [{"query": " "}, {"query": "x" * 161}, {"query": "MRI", "limit": 101},
                         {"query": "MRI", "limit": True}, {"query": "MRI", "path": "elsewhere"},
                         {"query": "MRI", "filters": {"yearFrom": 2025, "yearTo": 2020}},
                         {"query": "MRI", "filters": {"year": "2020"}}]:
                self.assertEqual(client.post("/search", json=body).status_code, 422, body)
            result = client.post("/search", json={"query": " MRI ", "filters": {"yearFrom": 2020}})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()["query"], "MRI")

    def test_snapshot_filters(self):
        row = {"metadata": {"year": 2024, "type": "preprint", "departments": ["Computing"], "researcher_ids": ["a" * 24]}}
        self.assertTrue(eligible(row, Filters(department="Computing", yearFrom=2020)))
        self.assertFalse(eligible(row, Filters(yearTo=2020)))
        self.assertFalse(eligible(row, Filters(type="journal-article")))
        self.assertFalse(eligible(row, Filters(researcher="b" * 24)))

    def test_corrupted_bundle_fails_closed_before_model_load(self):
        with TemporaryDirectory() as directory:
            bundle = Path(directory)
            (bundle / "documents.json").write_text("[]")
            manifest = {"status": "complete", "schema_version": 1,
                        "query_instruction": QUERY_INSTRUCTION, "max_length": 512,
                        "pooling": "final CLS", "normalization": "L2", "document_instruction": "",
                        "dtype": "float32", "files": {"documents.json": "incorrect-hash"}}
            (bundle / "manifest.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "integrity"):
                SearchEngine(bundle)
            with self.assertLogs(level="ERROR"):
                with TestClient(create_app(engine_factory=lambda: SearchEngine(bundle))) as client:
                    self.assertEqual(client.get("/health").status_code, 503)
                    self.assertEqual(client.post("/search", json={"query": "MRI"}).status_code, 503)


if __name__ == "__main__":
    unittest.main()
