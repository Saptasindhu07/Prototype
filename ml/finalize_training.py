"""Wait for an existing training run, audit it, and stage a verified serving bundle.

Does not train another epoch, edit .env, start a server, or activate the app.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import shutil
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent


def save_status(run, phase, **details):
    path = run / "finalization-status.json"
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"phase": phase, "updated_at_utc": datetime.now(timezone.utc).isoformat(), **details}, indent=2), encoding="utf-8")
    temporary.replace(path)
    print(phase, flush=True)


def finalize(run, threads=4, wait_hours=24, existing_bundle=None, node_executable=None):
    run = Path(run).resolve()
    if not (run / "config.json").is_file():
        raise ValueError("Expected an existing training run")

    with (run / "finalization.lock").open("x") as lock:
        import os
        lock.write(str(os.getpid()))
    try:
        save_status(run, "waiting-for-training", live_connection_enabled=False)
        deadline = time.monotonic() + wait_hours * 3600
        while not (run / "report.json").exists():
            if (run / "failure.json").exists():
                raise RuntimeError("Training failed; see failure.json")
            if time.monotonic() >= deadline:
                raise TimeoutError("Training did not finish within the waiting window")
            time.sleep(5)

        import numpy as np
        import torch
        from transformers import AutoModel, AutoTokenizer
        from research_ml.data import read_json, write_json
        from train_search import encode_texts
        from evaluate_selected_checkpoint import evaluate
        from build_neural_bundle import build_bundle

        torch.set_num_threads(threads)
        report, config = read_json(run / "report.json"), read_json(run / "config.json")
        if report["status"] != "complete" or report["epochs_completed"] != 1:
            raise ValueError("Expected one successfully completed full epoch")
        expected = {row["positive_paper_id"] for row in read_json(Path(config["data_dir"]) / "train.json")}
        steps = [json.loads(line) for line in (run / "training.jsonl").read_text().splitlines()]
        ids = [paper for step in steps for paper in step["paper_ids"]]
        if len(ids) != len(expected) or set(ids) != expected:
            raise ValueError("Training did not cover every expected paper exactly once")
        before, after = report["validation_before"]["cross_entropy"], report["validation_after"]["cross_entropy"]
        selected = Path(report["selected_checkpoint"])
        if (selected == Path(report["checkpoint_dir"])) != (after <= before):
            raise ValueError("Checkpoint selection disagrees with validation rule")
        save_status(run, "verifying-checkpoint", selected_checkpoint=str(selected))

        checkpoint = Path(report["checkpoint_dir"])
        tokenizer = AutoTokenizer.from_pretrained(checkpoint, local_files_only=True)
        model = AutoModel.from_pretrained(checkpoint, local_files_only=True, use_safetensors=True).eval()
        with torch.inference_mode():
            actual = encode_texts(model, tokenizer, read_json(run / "checkpoint_check_query.json"), "cpu", True).numpy()
        np.testing.assert_allclose(actual, np.load(run / "checkpoint_check_vector.npy", allow_pickle=False), atol=1e-6, rtol=1e-5)
        del model, tokenizer
        import gc
        gc.collect()

        if existing_bundle:


            bundle = Path(existing_bundle).resolve()
            manifest = read_json(bundle / "manifest.json")
            heldout = read_json(run / "heldout-proxy-report.json")
            frozen = read_json(run / "heldout-selection.json")
            if (manifest["status"] != "complete" or Path(manifest["source_training_run"]) != run
                    or Path(manifest["selected_checkpoint"]) != selected
                    or manifest["corpus_fingerprint"] != config["data_manifest"]["corpus_fingerprint"]
                    or heldout["status"] != "complete" or heldout["model_selected_using_test"] is not False
                    or Path(heldout["selected_checkpoint"]) != selected
                    or Path(frozen["selected_checkpoint"]) != selected):
                raise ValueError("Existing bundle does not match the frozen completed run")
        else:
            save_status(run, "evaluating-frozen-checkpoint", selected_checkpoint=str(selected))
            heldout = evaluate(run, threads=threads)
            save_status(run, "building-matching-paper-index", selected_checkpoint=str(selected))
            bundle = build_bundle(run, ROOT / "work/ml/corpus-v1.json", ROOT / "work/ml/bundles", threads=threads)

        save_status(run, "verifying-inference-contract", bundle=str(bundle))
        from fastapi.testclient import TestClient
        from inference_api import SearchEngine, create_app
        engine = SearchEngine(bundle)
        with TestClient(create_app(engine_factory=lambda: engine)) as client:
            assert client.get("/health").json()["ready"] is True
            response = client.post("/search", json={"query": "machine learning for scientific research", "limit": 10})
            assert response.status_code == 200
            result = response.json()
            assert len(result["hits"]) == min(10, len(engine.rows))
            assert all(a["score"] >= b["score"] for a, b in zip(result["hits"], result["hits"][1:]))
            restricted = client.post("/search", json={"query": "research", "filters": {"yearFrom": 9999}})
            assert restricted.status_code == 200 and restricted.json()["hits"] == []
            assert client.post("/search", json={"query": " "}).status_code == 422
        fixture = run / f"inference-smoke-{uuid.uuid4().hex[:8]}.json"
        write_json(fixture, result)

        node_path = node_executable or shutil.which("node")
        if not node_path:
            raise ValueError("Node executable not found; provide --node-executable")
        subprocess.run([str(Path(node_path).resolve()), "--input-type=module", "-e",
            "import fs from 'node:fs'; import {validateInferenceResult} from './apps/api/src/services/recommendation.service.js'; validateInferenceResult(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')));",
            str(fixture)], cwd=ROOT, check=True)
        ready = {"status": "ready-for-joint-connection", "live_connection_enabled": False,
                 "bundle": str(bundle), "selected_checkpoint": str(selected),
                 "model_version": engine.version, "papers_indexed": len(engine.rows),
                 "training_papers_verified": len(ids), "validation_before": report["validation_before"],
                 "validation_after": report["validation_after"], "heldout_proxy": heldout,
                 "checks": ["full-epoch-coverage", "checkpoint-reload", "bundle-integrity", "real-inference-api", "python-express-contract"],
                 "limitation": "Weak-label proxy evaluation does not establish real-query relevance or supervisor suitability."}
        write_json(run / "ready-model.json", ready)
        save_status(run, "ready-for-joint-connection", bundle=str(bundle), live_connection_enabled=False)
    except BaseException as error:
        save_status(run, "failed", error_type=type(error).__name__, message=str(error), live_connection_enabled=False)
        raise
    finally:
        (run / "finalization.lock").unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--training-run", type=Path, required=True)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--wait-hours", type=float, default=24)
    parser.add_argument("--existing-bundle", type=Path, help="Resume verification of a completed matching bundle; never repeat the held-out test")
    parser.add_argument("--node-executable", type=Path, help="Explicit Node executable for Windows subprocess launch")
    args = parser.parse_args()
    if args.threads < 1 or args.wait_hours <= 0:
        parser.error("threads and wait-hours must be positive")
    finalize(args.training_run, args.threads, args.wait_hours, args.existing_bundle, args.node_executable)
