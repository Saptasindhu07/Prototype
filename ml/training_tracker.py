"""Read-only local training dashboard. No model imports or application connection."""
import argparse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import time


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return default


def snapshot(run, total_steps):
    config = read_json(run / "config.json", {})
    prior = read_json(Path(config["continued_from"]) / "report.json", {}) if config.get("continued_from") else {}
    prior_steps = prior.get("steps_completed", 0) if prior.get("status") == "complete" else 0
    trace = run / "training.jsonl"
    rows = []
    if trace.exists():
        for line in trace.read_text(encoding="utf-8").splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    step = min(rows[-1]["step"] if rows else 0, total_steps)
    report = read_json(run / "report.json", {})
    failure = read_json(run / "failure.json")
    finalization = read_json(run / "finalization-status.json", {})
    phase = finalization.get("phase", "waiting-for-training")
    if failure:
        phase = "training-failed"
    elif phase == "waiting-for-training" and step == total_steps and not report:
        phase = "validating-and-saving-checkpoint"
    elif phase == "waiting-for-training" and report.get("status") == "complete":
        phase = "training-complete"
    age = max(0, time.time() - trace.stat().st_mtime) if trace.exists() else None
    index_progress = None
    stderr = run / "finalization.stderr.log"
    if stderr.exists():
        with stderr.open("rb") as log:
            log.seek(max(0, stderr.stat().st_size - 8192))
            matches = re.findall(r"Building selected-model index:[^\r\n]*?\s(\d+)/(\d+)", log.read().decode("utf-8", errors="replace"))
        if matches:
            completed, total = map(int, matches[-1])
            index_progress = {"completed": completed, "total": total, "percent": round(completed / total * 100, 1)}
    connection = read_json(run / "live-connection.json", {})
    return {"run": run.name, "step": step, "totalSteps": total_steps,
            "epochPercent": round(step / total_steps * 100, 1),
            "overallPercent": round((prior_steps + step) / (prior_steps + total_steps) * 100, 1),
            "priorComplete": bool(prior_steps), "phase": phase,
            "trainingComplete": report.get("status") == "complete",
            "lastBatchAgeSeconds": round(age) if age is not None else None,
            "stale": phase == "waiting-for-training" and (age is None or age > 120),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "error": (failure or {}).get("message") or finalization.get("message"),
            "indexProgress": index_progress,
            "liveConnectionEnabled": connection.get("status") == "connected"}


def serve(run, total_steps, port):
    page = Path(__file__).with_name("training_tracker.html").read_bytes()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            route = self.path.split("?", 1)[0]
            if route not in ("/", "/api/status"):
                self.send_error(404)
                return
            try:
                data = page if route == "/" else json.dumps(snapshot(run, total_steps), allow_nan=False).encode()
            except (OSError, ValueError, KeyError):
                self.send_error(503, "Training status temporarily unreadable")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8" if route == "/" else "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Live training tracker: http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--training-run", type=Path, required=True)
    parser.add_argument("--total-steps", type=int, required=True)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    if args.total_steps < 1 or not 1024 <= args.port <= 65535:
        parser.error("Invalid step count or port")
    if not (args.training_run / "config.json").is_file():
        parser.error("Expected an existing training run")
    serve(args.training_run.resolve(), args.total_steps, args.port)
