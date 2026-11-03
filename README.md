# Research Atlas

University of Otago research discovery prototype with publication search,
evidence-based neural recommendations, and an independent ML evaluation workflow.

## Repository

```text
apps/web/               React + Vite application, features, and browser tests
apps/api/               Express routes, services, schemas, data tools, and tests
packages/search/        Pure lexical search rules shared by both applications
ml/research_ml/         Corpus preparation, BM25 baseline, and ranking metrics
ml/notebooks/           Interactive learning and experiments
ml/tests/               Offline benchmark and neural-service tests
ml/*.py                 Training, evaluation, indexing, inference, and tracking
scripts/               Development, launch, and verification commands
docs/                  Architecture, frontend, API, data, and ML documentation
output/pdf/            Generated prototype documentation
work/                  Local runtime data, model artifacts, logs, and QA output
```

JavaScript applications use npm workspaces. Python stays independent to preserve
the existing environment and saved model paths. Runtime datasets and models are
excluded from version control.

## Setup

Use Node.js 24 or newer and a local MongoDB instance. The ML environment uses
Python 3.14.6 with CPU PyTorch; versions are in `ml/requirements-neural.txt`.

```powershell
npm ci
npm run setup
npm run db:check
npm run dev
```

Configure MongoDB in `.env` before starting the API; never commit this file.
Default ports: web 5173, API 5000, inference 8100. The current demo uses web port 5174.

To start all four demo servers with the selected trained model:

```powershell
npm run master
```

Keep MongoDB running first. This command checks the database, then starts the web
app on 5174, API on its configured port (5000 by default), AI inference on 8100,
and training tracker on 8766. Logs appear together in the terminal. Press Ctrl+C
to stop all four; if one server exits, the others stop too. The Python environment
at `ml/.venv` and the local verified model artifacts must already exist. This serves
the saved model and does not start a new training run or change `.env`.

## Neural recommendations

Paper Trail presents up to three researchers with supporting publications, using
a verified index of 7,283 papers. It describes topic fit, not supervision availability.
With MongoDB running, enable the verified model and API:

```powershell
./scripts/start-neural.ps1 -ReadyModelPath work/ml/training-runs/bge-full-20261103T093751720940Z-bdc36df2/ready-model.json
```

The launcher enables AI for its child processes without changing `.env`. Ordinary
API startup defaults to AI disabled. See [operations](docs/neural-service.md).

## Checks

```powershell
npm test
npm run build
& ml/.venv/Scripts/python.exe -m unittest discover -s ml/tests -v
& ml/.venv/Scripts/python.exe -m unittest discover -s ml/tests/neural -v
node scripts/verify-neural-live.mjs work/ml/training-runs/bge-full-20261103T093751720940Z-bdc36df2/ready-model.json
```

The default JavaScript suite excludes the opt-in disposable MongoDB test.
Live recommendation verification uses read-only application database queries.

## Documentation

- [Architecture](docs/architecture.md)
- [Frontend](docs/frontend.md)
- [Researcher API](docs/api.md)
- [Data ingestion](docs/data-ingestion.md)
- [ML development and Version 2 roadmap](docs/ml-development.md)
- [Neural service and evaluation](docs/neural-service.md)

Held-out title/content proxy top-1 matching improved from 96.78% to 98.30%.
This does not measure real-query relevance or professor suitability.
