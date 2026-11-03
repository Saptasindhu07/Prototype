"""Private loopback inference service; activation requires an explicit bundle path.

Run: python -m uvicorn inference_api:app --app-dir ml --host 127.0.0.1 --port 8100
Set AI_MODEL_BUNDLE to a completed build_neural_bundle.py output first.
"""
from contextlib import asynccontextmanager
import logging
import os
from pathlib import Path
import re
import threading
from typing import Annotated, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer

from build_neural_bundle import file_hash
from research_ml.data import fingerprint, read_json
from train_search import encode_texts, QUERY_INSTRUCTION

ID = re.compile(r"^[a-fA-F0-9]{24}$")
Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=160)]
Year = Annotated[int, Field(strict=True, ge=1000, le=9999)]


class Filters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    department: Text | None = None
    researcher: Annotated[str, StringConstraints(pattern=r"^[a-fA-F0-9]{24}$")] | None = None
    year: Year | None = None
    yearFrom: Year | None = None
    yearTo: Year | None = None
    type: Literal["journal-article", "conference-paper", "preprint", "book-chapter", "thesis", "other"] | None = None

    @model_validator(mode="after")
    def check_range(self):
        if self.year is not None and (self.yearFrom is not None or self.yearTo is not None):
            raise ValueError("Use year or yearFrom/yearTo")
        if self.yearFrom is not None and self.yearTo is not None and self.yearFrom > self.yearTo:
            raise ValueError("Invalid year range")
        return self


class SearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: Text
    limit: Annotated[int, Field(strict=True, ge=1, le=100)] = 100
    filters: Filters = Field(default_factory=Filters)


def eligible(row, filters):
    meta = row["metadata"]
    if filters.department and filters.department not in meta.get("departments", []):
        return False
    if filters.researcher and filters.researcher.lower() not in meta.get("researcher_ids", []):
        return False
    year = meta.get("year")
    if filters.year is not None and year != filters.year:
        return False
    if filters.yearFrom is not None and (year is None or year < filters.yearFrom):
        return False
    if filters.yearTo is not None and (year is None or year > filters.yearTo):
        return False
    return not filters.type or meta.get("type") == filters.type


class SearchEngine:
    def __init__(self, bundle):
        bundle = Path(bundle)
        manifest = read_json(bundle / "manifest.json")
        if manifest.get("status") != "complete" or manifest.get("schema_version") != 1:
            raise ValueError("Incomplete model bundle")
        if (manifest.get("query_instruction") != QUERY_INSTRUCTION or manifest.get("max_length") != 512
                or manifest.get("pooling") != "final CLS" or manifest.get("normalization") != "L2"
                or manifest.get("document_instruction") != "" or manifest.get("dtype") != "float32"):
            raise ValueError("Incompatible encoding settings")
        for name, expected in manifest["files"].items():
            if name not in ("embeddings.npy", "documents.json") or file_hash(bundle / name) != expected:
                raise ValueError("Index integrity check failed")
        if set(manifest["files"]) != {"embeddings.npy", "documents.json"}:
            raise ValueError("Missing index files")
        hashes = manifest["encoder_files"]
        for name, expected in hashes.items():
            if Path(name).name != name or file_hash(bundle / "encoder" / name) != expected:
                raise ValueError("Encoder integrity check failed")
        if fingerprint(hashes) != manifest["model_fingerprint"]:
            raise ValueError("Encoder/index fingerprint mismatch")
        vectors = np.load(bundle / "embeddings.npy", allow_pickle=False)
        rows = read_json(bundle / "documents.json")
        if vectors.shape != (len(rows), 384) or list(vectors.shape) != manifest["shape"] or vectors.dtype != np.float32:
            raise ValueError("Index shape or dtype mismatch")
        if not np.isfinite(vectors).all() or not np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=1e-5):
            raise ValueError("Invalid index vectors")
        if len({r["id"] for r in rows}) != len(rows):
            raise ValueError("Repeated index IDs")
        for row in rows:
            ids = row["metadata"].get("mongo_ids", [])
            if not ids or not all(isinstance(i, str) and ID.fullmatch(i) for i in ids):
                raise ValueError("Invalid publication mapping")
        self.rows, self.vectors, self.manifest = rows, vectors, manifest
        self.tokenizer = AutoTokenizer.from_pretrained(bundle / "encoder", local_files_only=True, padding_side="right", truncation_side="right")
        self.model = AutoModel.from_pretrained(bundle / "encoder", local_files_only=True, use_safetensors=True).eval()
        self.lock = threading.Lock()
        self.version = manifest["model_fingerprint"][:16]

    def search(self, request):
        indices = np.array([i for i, row in enumerate(self.rows) if eligible(row, request.filters)], dtype=np.int64)
        hits = []
        if len(indices):
            with self.lock, torch.inference_mode():
                vector = encode_texts(self.model, self.tokenizer, [request.query], "cpu", True)[0].numpy()
            scores = np.clip(self.vectors[indices] @ vector, -1.0, 1.0)
            order = np.argsort(-scores, kind="stable")[:request.limit]
            hits = [{"id": self.rows[int(indices[j])]["id"], "score": float(scores[j]),
                     "mongoIds": self.rows[int(indices[j])]["metadata"]["mongo_ids"]} for j in order]
        return {"hits": hits, "modelVersion": self.version,
                "corpusFingerprint": self.manifest["corpus_fingerprint"],
                "eligiblePaperCount": len(indices), "indexedPaperCount": len(self.rows)}


def create_app(engine_factory=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.engine, app.state.failed = None, False
        try:
            if engine_factory:
                app.state.engine = engine_factory()
            elif os.environ.get("AI_MODEL_BUNDLE"):
                torch.set_num_threads(4)
                app.state.engine = SearchEngine(os.environ["AI_MODEL_BUNDLE"])
        except Exception:
            app.state.failed = True
            logging.exception("Inference bundle failed startup verification")
        yield
        app.state.engine = None

    app = FastAPI(title="Research Atlas private inference", lifespan=lifespan)

    @app.get("/health")
    def health():
        if app.state.failed:
            raise HTTPException(503, "Model bundle failed verification")
        engine = app.state.engine
        return {"ready": engine is not None, "modelVersion": engine.version if engine else None}

    @app.post("/search")
    def search(request: SearchRequest):
        engine = app.state.engine
        if engine is None:
            raise HTTPException(503, "Recommendations are not connected yet")
        return engine.search(request)

    return app


app = create_app()
