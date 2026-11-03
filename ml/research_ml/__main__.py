"""CLI for the independent ML workspace. Run from ml or use ml/benchmark.py."""

import argparse
import json
from pathlib import Path
import sys
from .benchmark import (evaluate_run, review_candidates, run_baseline,
                        save_report, validate_benchmark)
from .data import export_mongodb, load_corpus, read_json, write_json
from .demo import demo_data
from .prepare import prepare_benchmark


def main(argv=None):
    parser = argparse.ArgumentParser(description="Independent MongoDB research benchmark; no app/API integration")
    commands = parser.add_subparsers(dest="command", required=True)
    snapshot = commands.add_parser("snapshot", help="Read-only MongoDB export")
    snapshot.add_argument("--out", required=True)
    snapshot.add_argument("--env-file", help="Explicit dotenv path; MONGODB_URI is never printed")
    prepare = commands.add_parser("prepare", help="Generate identifier controls and pending topics")
    prepare.add_argument("--corpus", required=True)
    prepare.add_argument("--out", required=True)
    run = commands.add_parser("run", help="Run independent BM25 baseline")
    evaluate = commands.add_parser("evaluate", help="Evaluate a compatible saved run, including future models")
    for command in (run, evaluate):
        command.add_argument("--corpus", required=True)
        command.add_argument("--benchmark", required=True)
        command.add_argument("--out", required=True, help="New output directory")
        command.add_argument("--cutoffs", type=int, nargs="+", default=[3, 5, 10])
    run.add_argument("--split", choices=["dev", "test", "all"], default="dev")
    run.add_argument("--depth", type=int, default=50)
    run.add_argument("--k1", type=float, default=1.2)
    run.add_argument("--b", type=float, default=.75)
    evaluate.add_argument("--run", required=True)
    demo = commands.add_parser("demo", help="Run fictional corpus without MongoDB or extra packages")
    demo.add_argument("--out", required=True, help="New output directory")
    args = parser.parse_args(argv)
    try:
        if Path(args.out).exists():
            raise ValueError("Output already exists; choose a new versioned path")
        if args.command == "snapshot":
            corpus = export_mongodb(args.out, args.env_file)
            print(json.dumps({"snapshot": args.out, "documents": len(corpus["documents"]),
                              "fingerprint": corpus["fingerprint"], "counts": corpus["metadata"]["raw_counts"]}))
        elif args.command == "prepare":
            corpus = load_corpus(args.corpus)
            benchmark = validate_benchmark(prepare_benchmark(corpus), corpus)
            write_json(args.out, benchmark)
            print(json.dumps({"benchmark": args.out, "queries": len(benchmark["queries"]),
                              "note": "Topic relevance labels are pending, not inferred from baseline scores."}))
        else:
            if args.command == "demo":
                corpus, benchmark = demo_data()
                run_data = run_baseline(corpus, benchmark)
                cutoffs = [3, 5, 10]
            else:
                corpus, benchmark = load_corpus(args.corpus), read_json(args.benchmark)
                cutoffs = args.cutoffs
                run_data = (run_baseline(corpus, benchmark, args.split, args.depth, args.k1, args.b)
                            if args.command == "run" else read_json(args.run))
            report = evaluate_run(run_data, corpus, benchmark, cutoffs)
            save_report(args.out, run_data, report, review_candidates(run_data, corpus, benchmark))
            if args.command == "demo":
                write_json(Path(args.out) / "corpus.json", corpus)
                write_json(Path(args.out) / "benchmark.json", benchmark)
            print(json.dumps({"report": str(Path(args.out) / "report.json"), "queries": report["query_count"],
                              "statuses": report["statuses"], "latency_ms": report["latency_ms"]}))
            if report["statuses"].get("error"):
                return 1
        return 0
    except (ValueError, OSError) as exc:

        print(f"Benchmark failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Benchmark failed ({type(exc).__name__}); check dependencies/database and inputs. Connection details withheld.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
