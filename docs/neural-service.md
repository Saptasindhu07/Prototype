# Recommendation API and activation

## Current stage

The approved **Paper Trail** interface and both API layers are implemented and
connected locally following the user's continuation request on 2026-11-04
(Pacific/Auckland). The active API process has recommendations enabled. The
application defaults to `AI_RECOMMENDATIONS_ENABLED=false`; the actual `.env`
has not been changed. MongoDB is read only in the recommendation path.

Live application: `http://127.0.0.1:5174/?q=software%20testing`.
Tracker: `http://127.0.0.1:8766/`. Model version: `4146091392dfb2ef`.
Verified bundle: `work/ml/bundles/bge-bundle-20261103T111137217508Z-815e60e0`.
It contains 7,283 normalized 384-dimensional vectors; 464 source papers exceed
the 512-token input limit and were truncated (recorded individually).

First complete fine-tuning epoch:
`work/ml/training-runs/bge-full-20261103T084710021777Z-da62f3b0`.
All 4,354 screened pairs appeared exactly once in 545 optimizer steps.
Validation cross-entropy improved from 0.839422 to 0.107937 on its fixed
531-group proxy pool. This measures title-to-content matching, not real user
relevance or supervisor suitability.

The second full epoch completed in
`work/ml/training-runs/bge-full-20261103T093751720940Z-bdc36df2`, with batch size 8,
learning rate 5e-6, and seed 43. It continues weights and optimizer state from
the first full epoch. Its before/after validation pool is fixed within the run;
do not compare losses across differently sampled validation pools directly.
No further epoch is automatically scheduled. It covered all 4,354 pairs in 545
steps, bringing the total to 1,100 optimizer steps including the 10-step pilot.
Within this run, validation cross-entropy improved from 0.107924 to 0.098597,
and title/content top-1 accuracy improved from 97.93% to 98.12%. The second
checkpoint was selected before opening the held-out test.

The held-out proxy audit is complete: on the same 528-group pool, pretrained
cross-entropy/top-1 were 1.324713 / 96.78%; selected-model values were
0.115707 / 98.30%. These are proxy matching results, not measured accuracy for
real user questions or researcher suitability.

`ml/finalize_training.py` completed the background pipeline for this run.
It waits for successful training completion, then:

1. Checks every training paper appeared exactly once and verifies serialization.
2. Uses the checkpoint selected by **validation loss**, before observing the test.
3. Evaluates pretrained and selected encoders once on the same held-out proxy
   pool (528 unique groups). Test results do not trigger more training/selection.
4. Rebuilds all 7,283 paper vectors using the selected encoder. The existing
   pretrained index is preserved.
5. Verifies file hashes, vector shapes/norms, actual FastAPI inference, and the
   Python response against Express's contract validator.
6. Writes `ready-model.json` and marks `finalization-status.json` as
   `ready-for-joint-connection`. It does **not** edit `.env` or start live servers.

Read `training.jsonl` for progress, `report.json` for completed training,
`heldout-proxy-report.json` for test diagnostics, and `finalization-status.json`
for packaging state. `finalization.stderr.log` records errors. A folder existing
does not establish successful completion. The worker times out after 24 hours;
training errors stop finalization. Do not start a duplicate finalizer while its
`finalization.lock` belongs to an active process. If a phase fails, inspect its
artifacts before resuming; held-out reports must not be silently overwritten.

The original finalizer reached real Python inference verification but failed
to launch Node by bare executable name on Windows (`WinError 5`). Resolving the
full executable path fixed it. Verification resumed with `--existing-bundle`
and `--node-executable`; the held-out test and embedding build were not repeated.
Readiness was written only after the resumed checks passed.

## Request path

The browser sends `POST /api/recommendations` only when the user opens the panel:

```json
{
  "query": "machine learning for scientific research",
  "filters": { "yearFrom": 2020, "department": "School of Computing" }
}
```

Query length is 1–160 characters. Optional filters are `department`, `researcher`
(verified Mongo ID), `year`, `yearFrom`, `yearTo`, and `type`. Use an exact year
or a year range, not both. Publication types follow the existing application.
Lexical match mode and manual result sort do not control neural similarity.

Express calls private `POST http://127.0.0.1:8100/search` with query, filters,
and limit 100. The Python service loads the encoder and matching index once.
It filters the saved index, embeds the query with the BGE retrieval instruction,
and ranks normalized vectors by cosine similarity. It returns canonical IDs,
source Mongo IDs, scores, and model/corpus fingerprints. It never reads MongoDB.

Express hydrates returned IDs from MongoDB, reapplies current filters, and uses
only verified `authors[].researcherId` links. It deduplicates paper evidence,
ranks researchers by the mean of up to three best retrieved papers, and returns
up to three researchers with supporting publications. It does not match authors
by name, generate supervision claims, or treat cosine scores as probabilities.

Response:

```text
data: { query, recommendations: [
  { researcher: { _id, name, affiliations, researchInterests, profileUrl },
    rankingScore, reason, papers: [{ _id, title, abstract, year, similarity, ... }] }
] }
meta: { engine, modelVersion, corpusFingerprint, indexedPaperCount,
        eligiblePaperCount, candidatePaperCount, ranking,
        supervisionAvailabilityVerified: false }
```

Invalid public requests return 400. Disabled/unavailable model requests return
503 with a safe message. `/api/recommendations/status` describes configuration,
not model health. Python `/health` reports readiness after bundle verification.
The upstream timeout is 15 seconds; Mongo reads have 5-second limits.

## Paper Trail behavior

The button sits beside ordinary search results. Its nonmodal floating dialog
shows researcher cards, paper evidence, expandable abstracts, and the existing
paper-detail dialog. Query/filter changes close the panel and cancel stale
requests. Loading, retry, unavailable, and empty states are implemented. Escape
closes it; focus returns to the trigger when appropriate. It fits desktop/mobile
and respects reduced motion. `?demo=1&q=software` uses explicitly fictional local
records solely to preview layout. Demo suggestions are not model-ranked.

## Starting the verified local connection

The user authorized continuing to live integration after training on 2026-11-04
(Pacific/Auckland). A guarded launcher is available once `ready-model.json`
exists and MongoDB is running:

```powershell
./scripts/start-neural.ps1 -ReadyModelPath work/ml/training-runs/bge-full-20261103T093751720940Z-bdc36df2/ready-model.json
node scripts/verify-neural-live.mjs work/ml/training-runs/bge-full-20261103T093751720940Z-bdc36df2/ready-model.json
```

The launcher sets the model path and enabled flag only for its child processes;
it does not change `.env`. It checks model identity/readiness and MongoDB before
starting Express, and refuses an existing incompatible service. The verifier
uses real model responses and read-only MongoDB lookups, checks paper-author
links and live filters, and writes `live-connection.json` only after success.
Use this launcher again after stopping services; a normal server restart still
uses the disabled-by-default `.env` configuration unless explicitly changed.

For manual service startup instead of the launcher, from the project root:

```powershell
$runPath = 'work/ml/training-runs/bge-full-20261103T093751720940Z-bdc36df2'
$readyModel = Get-Content (Join-Path $runPath 'ready-model.json') -Raw | ConvertFrom-Json
$env:AI_MODEL_BUNDLE = $readyModel.bundle
& ml/.venv/Scripts/python.exe -m uvicorn inference_api:app --app-dir ml --host 127.0.0.1 --port 8100
```

The ML venv also requires `ml/requirements-inference.txt` (installed locally).
Check `/health`, then enable `AI_RECOMMENDATIONS_ENABLED=true` in the application's
environment and restart Express. `AI_INFERENCE_URL` defaults to
`http://127.0.0.1:8100`; only loopback HTTP addresses are accepted. The browser
continues using its existing Express origin. To disconnect, disable the flag and
restart Express. No database migration or frontend rebuild is needed to switch
the model connection. Future corpus changes require a new matching bundle.

## Verification and limits

Passed: 89 Node tests covering recommendations and existing search regressions;
20 offline benchmark tests and 5 Python API/integrity/finalization tests; Vite production build; actual Chrome desktop/mobile,
selection/paper dialog, focus/Escape, loading/error/retry/empty, and query-change
checks. Browser artifacts are under ignored `work/ui-qa/`.

```powershell
node --test --test-isolation=none apps/api/tests/recommendation.test.js packages/search/tests/search.test.js apps/api/tests/discovery.routes.test.js apps/web/tests/recommendations.test.js apps/web/tests/discovery.test.js
& ml/.venv/Scripts/python.exe -m unittest discover -s ml/tests/neural -v
# With the local Vite preview running on 127.0.0.1:5174:
node scripts/test-ai-ui.mjs
```

Real selected-model/index verification and local MongoDB/API integration passed.
`live-connection.json` records the real query checks, model version, IDs, and
timings. Queries included `software testing` and `protein structure` filtered
to Biochemistry from 2020; an empty year range and invalid input were checked.
The verifier re-read each returned paper and researcher to confirm author IDs
and filters. Ordinary manual search also returned successfully.

The actual browser flow passed using live records: AI button, researcher
selection, paper expansion, existing paper-detail dialog, closing, and reopening.
Screenshot: `work/ui-qa/paper-trail-live.png`. Sample-mode browser checks remain
separate from this live verification.
The build has a bundle-size advisory for the existing main chunk over 500 kB.

The ranking rule is a prototype heuristic, not a trained professor-suitability
model. Only the top 100 paper candidates contribute; researchers without verified
links cannot be suggested. New/deleted records and changed affiliations can make
the snapshot stale; live checks can remove stale candidates but cannot recover
new papers absent from the index. There is no calibrated relevance threshold,
so returned neighbors need not be good matches for an unrelated query. Human
relevance judgments and real-query benchmark evaluation remain necessary.

Training uses weak title/content positives and assumed in-batch negatives;
related papers can be false negatives. Full text is absent, and long combined
text is truncated to 512 tokens. Field weighting and full-text chunks remain
the recorded Version 2 experiments in the ML README.
