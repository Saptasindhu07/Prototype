"""One-time proxy-test audit after validation-based model selection is frozen."""
import argparse
import gc
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer

from research_ml.data import fingerprint, read_json, write_json
from train_search import MODEL_ID, REVISION, epoch_rows, evaluate_proxy


def evaluate(training_run, batch_size=8, threads=4):
    training_run = Path(training_run)
    output = training_run / "heldout-proxy-report.json"
    if output.exists():
        raise ValueError("Held-out report already exists; do not silently repeat model selection")
    report = read_json(training_run / "report.json")
    config = read_json(training_run / "config.json")
    if report["status"] != "complete":
        raise ValueError("Training must finish before evaluating the held-out split")
    data_dir = Path(config["data_dir"])
    manifest = read_json(data_dir / "manifest.json")
    test_rows = read_json(data_dir / "proxy_test.json")
    if fingerprint(test_rows) != manifest["split_fingerprints"]["proxy_test"]:
        raise ValueError("Proxy-test data changed")
    for name in ("train", "validation"):
        rows = read_json(data_dir / f"{name}.json")
        if {r["group_id"] for r in rows} & {r["group_id"] for r in test_rows}:
            raise ValueError("Group leakage into proxy test")
    test_rows = epoch_rows(test_rows, 20042)
    selected = report.get("selected_checkpoint", report["checkpoint_dir"])

    write_json(training_run / "heldout-selection.json", {
        "selected_checkpoint": selected, "selection_rule": report["selection_rule"],
        "query_ids": [r["positive_paper_id"] for r in test_rows],
        "test_split_fingerprint": manifest["split_fingerprints"]["proxy_test"],
    })
    torch.set_num_threads(threads)
    results = {}
    for label, source, options in [
        ("pretrained", MODEL_ID, {"revision": REVISION}),
        ("selected_fine_tuned", selected, {}),
    ]:
        print(f"Evaluating {label} on {len(test_rows)} held-out proxy pairs...", flush=True)
        tokenizer = AutoTokenizer.from_pretrained(source, **options, local_files_only=True)
        model = AutoModel.from_pretrained(source, **options, local_files_only=True, use_safetensors=True)
        results[label] = evaluate_proxy(model, tokenizer, test_rows, batch_size, "cpu", config["temperature"])
        del model, tokenizer
        gc.collect()
    result = {"status": "complete", "model_selected_using_test": False,
              "selected_checkpoint": selected, "results": results,
              "limitations": ["Titles are proxy queries; positives are same-paper content associations.",
                              "Results do not establish performance on real user queries or professor suitability.",
                              "Semantic duplicate screening is incomplete."]}
    write_json(output, result)
    print(result, flush=True)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--training-run", required=True, type=Path)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    evaluate(args.training_run, args.batch_size, args.threads)
