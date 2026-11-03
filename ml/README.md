# Machine learning

Independent Python training, evaluation, and inference for Research Atlas.

- `research_ml/`: corpus preparation, BM25 baseline, and ranking metrics.
- `notebooks/`: interactive learning and experiments.
- `tests/`: offline benchmark tests; `tests/neural/` covers model-service contracts.
- Root Python entry points: pair preparation, training, evaluation, bundle creation,
  inference API, and progress tracking.
- `.venv/`: local environment, excluded from version control.

See [ML development](../docs/ml-development.md) and
[neural service operations](../docs/neural-service.md).
Runtime datasets, checkpoints, and indexes remain under `work/ml/`.
