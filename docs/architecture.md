# Architecture

```text
Browser / React ----> Express API ----> MongoDB
                            |
                            +----> FastAPI ----> trained encoder + paper index
```

## Boundaries

- `apps/web`: presentation and browser state; no imports from API models.
- `apps/api`: public request validation, database access, verified author mapping,
  and researcher aggregation.
- `packages/search`: pure lexical parsing, scoring, and publication-link helpers
  shared through npm workspace imports.
- `ml/research_ml`: independent BM25 benchmark workflow.
- ML entry points: weak-label preparation, BGE training, frozen evaluation,
  matching index construction, private inference, and progress tracking.
- `scripts`: development and verification commands.

## Retrieval

Manual search filters records, scores literal matches, conservatively groups
duplicate works, ranks all matches, and paginates. Neural search embeds a query,
scores filtered paper vectors, returns up to 100 candidates, then maps them to
verified researchers. Researcher scores average up to three best retrieved papers.
These are separate search paths, not a blended ranking system.

The Python service loads an immutable model/index bundle and has no database
connection. Express rehydrates paper IDs from MongoDB and reapplies live filters.
Bundles include encoder weights, tokenizer, normalized vectors, document IDs,
hashes, and provenance. Query and paper vectors must use the same checkpoint.

The system does not run a generative LLM. Recommendation reasons refer directly
to retrieved publication evidence. Weights update only during offline training.

## Maintenance

The 2026-11-04 reorganization preserves runtime artifacts and provenance. Historical
run configurations retain original paths and hashes. Redundant code comments were
removed; API docstrings and notebook teaching material remain. The local source
backup is `work/refactor/source-before.zip` (excluded from version control).
