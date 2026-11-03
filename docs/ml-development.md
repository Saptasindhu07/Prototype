# Independent research ML workspace

The training and benchmark workflows use a read-only database export and run offline.
The trained encoder is also served by the private inference API described in
[neural service operations](neural-service.md). Training and benchmark commands
do not modify application records.

## What is ready

- A read-only MongoDB exporter, including titles, abstracts, keywords, researcher
  profiles and verified author links. Credentials are never saved in outputs.
- Immutable JSON corpus snapshots with content fingerprints. Exact DOI duplicates
  are collapsed; other versions remain separate. Department filters mean **current
  researcher-profile affiliations**, not historical affiliation on the paper.
- `independent-bm25-v1`: a standalone Okapi BM25 keyword baseline with exact DOI,
  ORCID and OpenAlex lookup. This is **not** the app's `literal-v1` engine.
- Precision@k, Recall@k, linear-gain nDCG@k and MRR@k; separate lookup hit-rate and
  no-match checks; latency, failures, coverage, and per-query results.
- A fictional fully judged demo; real-data identifier checks; pending topic
  queries; review candidate export; and a reusable saved-run evaluation format.
- A notebook at `notebooks/01_benchmark_baseline.ipynb` and standard-library tests.
- An independent BGE paper-embedding script at `embed_papers.py`; the full corpus
  run is user-controlled, with a small real-data smoke run verified separately.

## Setup (from the project root, PowerShell)

Python 3.11+ is required. The current local environment uses Python 3.14.
Only MongoDB export needs third-party packages. Offline search and evaluation do
not require PyTorch, NumPy, a running database, or a running application.

```powershell
python -m venv ml/.venv
& ml/.venv/Scripts/python.exe -m pip install -r ml/requirements.txt
& ml/.venv/Scripts/python.exe -m unittest discover -s ml/tests -v
```

The existing Jupyter Python kernel can run the benchmark notebook's offline cells.
Use the isolated environment above for CLI exports. The neural lessons use the
separately registered `Python (Research ML)` kernel backed by `ml/.venv`.

## Run the complete fictional demo

```powershell
& ml/.venv/Scripts/python.exe ml/benchmark.py demo --out work/ml/demo-v2
```

No MongoDB access occurs. All records and judgments are fictional and labeled as
such. This verifies the evaluation machinery; it is not measured product quality.
Every output path must be new: snapshots, suites and reports are never overwritten.

## Real database workflow

Start your existing MongoDB deployment first. Set `MONGODB_URI` in the environment,
or pass an explicit dotenv path. The existing root `.env` is read only when passed
with `--env-file`; the application itself is never loaded.

```powershell
& ml/.venv/Scripts/python.exe ml/benchmark.py snapshot --env-file .env --out work/ml/corpus-v2.json
& ml/.venv/Scripts/python.exe ml/benchmark.py prepare --corpus work/ml/corpus-v2.json --out work/ml/benchmark-v2.json
& ml/.venv/Scripts/python.exe ml/benchmark.py run --corpus work/ml/corpus-v2.json --benchmark work/ml/benchmark-v2.json --out work/ml/bm25-dev-v2
```

The exporter compares two reads of the projected source contents, rejecting a
changing database. This is a stability check, not a transactional point-in-time
snapshot. Export while importers/updaters are idle. Use a read-only database user
when one is available; the code issues only find operations.

`prepare` creates a deterministic pilot, not a claim of a representative labeled
benchmark. Identifier variants share a group/split. Topic queries are placeholders
to revise with domain knowledge. `run` defaults to the **dev** split and depth 50.
Use `--split test` only after configuration is frozen. Keep paraphrases and the
same underlying information need in the same group.

Publications use title + keywords + available abstract as BM25 input. Researchers
use name + biography + interests + linked publication text, joined only by verified
researcher IDs. BM25 uses OR matching, unique query terms, a documented small
stop-word list, no stemming, no semantic translation and deterministic ID tie
breaks. Quotes have no special phrase semantics. k1=1.2 and b=0.75 are untuned
starting settings. Researcher profiles containing many papers are longer documents;
length normalization does not guarantee absence of publication-volume bias.

Filters: publications accept `department`, `year_from`, `year_to`, `type`;
researchers accept `department`. Unsupported filters are rejected rather than
silently ignored. Paper-year/type constraints on researcher evidence are not part
of this baseline's current contract.

## Outputs and interpretation

Each run directory contains:

| File | Purpose |
| --- | --- |
| `run.json` | Ranked IDs/scores, query failures, configuration and fingerprints |
| `report.json` | Machine-readable per-query and grouped evaluation |
| `report.md` | Compact readable report |
| `review-candidates.json` | Unscored annotation candidates with source text |

The current local real snapshot has **7,283 publications and 134 researchers**.
Its generated pilot has 33 queries: 17 identifier controls and 16 pending topics.
The initial dev run evaluated 25 queries: 13 identifier controls scored, 12 topics
pending, zero query failures. All 13 dev lookup controls had their target at rank 1.
The test split remains unused. These numbers describe this local snapshot/run only.

Topic relevance scores remain absent until judgments exist. Lookup correctness
does not establish semantic retrieval quality. Search latency excludes snapshot
export, index construction, network requests and any future neural inference.

## Add relevance judgments later

Review candidates are a pool from one retriever, **not ground truth**. Combine
candidates from future semantic retrieval and manual search before judging.
Candidates hide original ranks/scores; `grade: null` means unreviewed.

Copy the benchmark to a new version and update each reviewed topic:

```json
{
  "judgment_scope": "pooled",
  "judgment_source": "human",
  "assessor": "Reviewer name",
  "judgment_notes": "Document IDs and short evidence-based reasons",
  "qrels": {"publication:REAL_MONGO_ID": 3, "publication:ANOTHER_REAL_ID": 0}
}
```

Keep all other query fields. Use actual IDs from the frozen corpus. Grades are
0=irrelevant, 1=broadly related, 2=relevant, 3=directly relevant. Each graded
ranking query must include at least one grade >=2; investigate queries with no
known positives before certifying a complete no-match case.

`complete` explicitly asserts all relevant eligible records have been identified;
omitted IDs are grade 0. `pooled` treats omitted IDs as unknown. At a cutoff with
unjudged returned documents, pooled metrics remain null. Otherwise pooled recall
is named `known_recall`, and other metrics are prefixed `pooled_`. They never share
an aggregate with complete judgments. Pending topics never receive zero scores.

Use separate dev and final test queries; later training pairs must exclude their
information needs and paraphrases. Do not derive relevance labels from BM25 scores.
The benchmark fingerprint includes judgments: regenerate runs after changing them.

## Evaluate a future model with the same harness

The future model supplies the same `run.json` contract: engine/configuration,
corpus and benchmark fingerprints, split, retrieval depth, latency scope, and one
outcome per selected query. Each outcome has `query_id`, `status`, `latency_ms`,
and ordered `ranking: [{"id": "...", "score": 0.7}]`. Record failures explicitly
with `status: "error"`, an empty ranking, and an error type. Never omit queries.

```powershell
& ml/.venv/Scripts/python.exe ml/benchmark.py evaluate --corpus work/ml/corpus-v1.json --benchmark work/ml/benchmark-v1.json --run work/ml/future-model/run.json --out work/ml/future-evaluation
```

Metrics use linear DCG gain, grade >=2 for binary relevance, and k as the precision
denominator even when fewer results are returned. Ideal DCG uses all known qrels,
not just retrieved hits. Errors contribute zero on otherwise evaluable queries;
reports show failures and scoring denominators. Duplicate/unknown IDs, missing
queries, filter violations, fingerprint mismatches and invalid cutoffs are rejected.

Implementation references: [BM25](https://nlp.stanford.edu/IR-book/html/htmledition/okapi-bm25-a-non-binary-model-1.html),
[linear-gain nDCG](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.ndcg_score.html),
[PyMongo](https://www.mongodb.com/docs/languages/python/pymongo-driver/current/get-started/).

## Build final paper embeddings with pretrained BGE

`embed_papers.py` reads the immutable corpus and encodes publication records only.
The exporter's `text` field already combines title, keywords and available
abstract. It is reused without repeating the title or inventing missing abstracts.
This is pretrained inference, not fine-tuning or generation of relevance labels.
No database connection, application API, or frontend/backend change is involved.

In the `Python (Research ML)` notebook kernel, run:

```python
%run "C:/Users/SaptaSindhu/Summer Project/Prototype/ml/embed_papers.py" --batch-size 8
```

Equivalent command from the project root in PowerShell:

```powershell
& ml/.venv/Scripts/python.exe ml/embed_papers.py --batch-size 8
```

The script uses `torch`, `transformers`, `numpy`, `tqdm`, `safetensors`, and
`huggingface-hub` from the neural environment. CPU is the default. It resolves
one checkpoint revision for both tokenizer and model and may download model
files on first use. `--local-files-only` restricts loading to cached files.

Each batch passes token IDs, token-type IDs and an attention mask into the full
model. The model handles its input embeddings and Transformer blocks internally.
The script selects the last-layer CLS vector and L2-normalizes it to produce
one 384-dimensional float32 embedding per paper, following the
[BGE model usage](https://huggingface.co/BAAI/bge-small-en-v1.5#using-huggingface-transformers).
It checks finite values, dimensions and unit norms before saving.

**Version 1 length policy:** right-truncate to 512 tokens including special
tokens. No chunking or field weighting is performed. The frozen `corpus-v1.json`
audit found 464 of 7,283 papers over this limit and 1,813 without abstracts;
long-text tails will therefore be omitted. Counts are recomputed for each run.
These limits must be disclosed in the final prototype documentation.

Every run creates a new timestamped folder under `work/ml/paper-embeddings/`:

- `paper_embeddings.npy`: rows are paper embeddings, shape `(N, 384)`.
- `papers.json`: aligned row numbers, original paper IDs, titles, source metadata,
  text hashes, original/encoded token counts and truncation flags.
- `manifest.json`: written last on success, with corpus fingerprint, model
  revision, settings, package versions and coverage counts.
- `failure.json`: written if execution fails or is interrupted; that run is
  incomplete and should not be used as an embedding index.

After `%run`, the `embedding_run` variable contains the manifest. Load saved data:

```python
import json
from pathlib import Path
import numpy as np

run_dir = Path(embedding_run["output_dir"])
paper_embeddings = np.load(run_dir / "paper_embeddings.npy", allow_pickle=False)
paper_records = json.loads((run_dir / "papers.json").read_text(encoding="utf-8"))
print(paper_embeddings.shape)
# paper_records[i] identifies paper_embeddings[i].
```

For a smoke test only, add `--limit 3`; the manifest flags partial-corpus output.
Existing outputs are never overwritten. Interrupted runs are not resumed; rerun
to create a fresh folder. Small checks covered real-data output/ID alignment,
unit norms, a short input's invariance to padding in a mixed-length batch, and
explicit truncation of an over-limit input. They do not measure search relevance.

## First weak-label BGE fine-tuning experiment

`train_search.py` implements actual gradient-based fine-tuning, independently of
the application and MongoDB. The default is a **10-step CPU pilot**, not a complete
training epoch or a claim of improved search quality. The user authorized starting
training after the notebook's pair preparation and split audit.

```powershell
& ml/.venv/Scripts/python.exe ml/train_search.py --max-steps 10 --batch-size 4
```

In the `Python (Research ML)` Jupyter kernel:

```python
%run "C:/Users/SaptaSindhu/Summer Project/Prototype/ml/train_search.py" --max-steps 10 --batch-size 4
# training_run contains this new experiment's report.
```

By default, each invocation starts a **new experiment from the pinned pretrained
revision** `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a`, using cached model files only.
Re-running does not automatically resume an earlier checkpoint. Explicit
`--continue-from <completed-run>` restores that run's model and AdamW state, checks
the dataset fingerprints, and starts new epochs. This is continuation of training,
not recovery of an interrupted batch cursor.

`prepare_neural_pairs.py` reproduces the notebook preparation: titles are proxy
queries, and the same paper's keywords + available abstract are weak positives.
The leading title is removed from the positive text; papers without abstracts are
excluded. These are not real user queries or human relevance judgments. Exact
title/content groups are split together, then `audit_pair_splits.py` reserves known
benchmark target groups and heuristically similar cross-split title groups. The
current snapshot yields 4,354 train, 538 validation, and 538 proxy-test pairs.
The screening does not certify semantic separation from benchmark information needs.

The shared encoder processes query text with the BGE retrieval instruction and
positive text without it. Final CLS vectors are L2-normalized. Loss is
`cross_entropy((query_vectors @ document_vectors.T) / 0.05, arange(batch_size))`:
the diagonal is positive, and other batch documents are assumed negatives.
One member of each known duplicate group is sampled per epoch. Related papers can
still be false negatives. A final singleton batch is skipped because it has no
negative candidate.

All 33,212,160 parameters on the CLS embedding path are trainable; the unused BERT
pooler is frozen. AdamW uses learning rate 1e-5, weight decay 0.01 on matrix
parameters, no decay on biases/LayerNorm vectors, and gradient-norm clipping at 1.
Query and content inputs are right-truncated at 512 tokens including special
tokens. Dropout is enabled during training and disabled for validation. The default
uses four CPU threads. `--max-steps` and `--epochs` both limit execution; the first
limit reached ends the pilot experiment. `--full-epoch` ignores `--max-steps` and
uses every screened training pair exactly once per requested epoch, with shuffled
length buckets to reduce padding and distinct known duplicate groups per batch.
A remaining singleton is merged into a compatible batch (at most batch size + 1).
For a one-epoch full run continuing the completed pilot:

```powershell
& ml/.venv/Scripts/python.exe ml/train_search.py --continue-from work/ml/training-runs/bge-pilot-20261103T083623971435Z-05256841 --full-epoch --epochs 1 --batch-size 8 --validation-size 538 --threads 12
```

That full run covers all 4,354 training pairs in 545 batches and validates on 531
unique validation groups. Selection compares starting versus final checkpoint
validation cross-entropy; `selected_checkpoint` in the completed report identifies
the lower-loss model. The full run was started at
`bge-full-20261103T084710021777Z-da62f3b0`; completion must be checked in its
`report.json`, rather than inferred from the presence of its folder or config.
Training remains independent; frontend integration is deferred.

**Full run completed and verified:** `bge-full-20261103T084710021777Z-da62f3b0`
finished one complete epoch in 545 optimizer steps (555 including the pilot).
Log verification confirmed all 4,354 screened training pairs were used exactly
once. On the same 531-group validation pool, cross-entropy changed from 0.839422
to 0.107937 and title/content top-1 accuracy from 97.55% to 97.93%. The final
checkpoint was selected by the stated validation rule. Reloading it reproduced
the saved query vector within atol 1e-6 / rtol 1e-5 with unit norm. These remain
weak-label proxy metrics; the final test has not been evaluated, and the paper
index has not yet been regenerated with the fine-tuned encoder.

Runs are saved under `work/ml/training-runs/bge-pilot-<UTC>-<uuid>/`:

- `data/`: frozen pairs, split fingerprints, preparation manifest, and audit report.
  `--data-dir <previous-run/data>` reuses that prepared data in a new experiment.
- `config.json`: model revision, data provenance, settings, versions, limitations,
  and hashes of the scripts used.
- `training.jsonl`: batch paper IDs, loss, gradient norm, epoch, and elapsed time.
- `gradient_check.json`: nonzero E/P/Q/K/V gradients and observed parameter changes
  after the first optimizer step. All active parameters are checked for gradients.
- `checkpoint/`: updated model safetensors/config and tokenizer; `optimizer_state.pt`
  holds the locally generated optimizer state.
- `report.json`: written after successful completion, including before/after
  validation diagnostics. `failure.json` marks an incomplete run.
- `checkpoint_check_query.json` and `checkpoint_check_vector.npy`: an inference
  reference for checking serialization/reloading.

Validation uses a fixed seeded sample of 32 unique validation groups against their
own 32 content candidates, before and after training. This is a weak-label matching
diagnostic, not corpus-wide search evaluation. Losses from different training
batches are not directly evidence of improvement. The proxy-test file is created
but is not opened by the training/validation loader, and no final test metrics are
computed. Benchmark topic relevance labels and information-need review remain
pending; this pilot must not be presented as a validated production model.

Saved pretrained paper embeddings remain unchanged. **Do not compare fine-tuned
query vectors against that pretrained index**: regenerate paper vectors with the
same fine-tuned checkpoint before evaluating or serving that encoder.

First completed pilot: `bge-pilot-20261103T083623971435Z-05256841` used 10 steps,
batch size 4, and 40 distinct training papers. On the same seeded 32-pair validation
subset, cross-entropy changed from 0.176998 to 0.095142; title/content top-1 accuracy
was 32/32 both before and after. The easy, small proxy evaluation does not establish
real search improvement. No final test was evaluated. The first-step audit recorded
nonzero gradients and parameter changes in E, P, and block-0 Q/K/V matrices; all
active parameters had gradients. Reloading the saved checkpoint reproduced its
reference query vector within atol 1e-6 / rtol 1e-5, with shape (1, 384) and unit norm.
Objective-alignment, two-branch gradient flow, singleton rejection, group sampling,
and preparation input-preservation checks also passed.

## Approved frontend design: Paper Trail

**Approved by the user on 2026-11-03 (Pacific/Auckland).** The user selected
the third design, **Paper Trail**, from the interactive recommendation mockups
and requested that this decision be logged. Include it in the final prototype
documentation as the approved frontend interaction design.

- Keep normal search results on the search page.
- Add a small, modern **AI Recommendations** button beside the results toolbar.
- Clicking the button opens the **bottom floating research-shortlist panel**.
- Show researcher/professor cards across the panel on desktop; stack them on
  narrow screens.
- Selecting a researcher updates the panel's research-fit explanation and
  related/supporting papers. Selecting a paper can expand its preview.
- Provide a close action and allow reopening the panel from the AI button.
- Preserve the compact styling, soft corners, restrained accent colors, and
  clear separation between the shortlist and supporting paper evidence.

Approved visual reference (carousel variant **Paper Trail**):
`C:/Users/SaptaSindhu/.codex/visualizations/2026/10/23/01a16a85-de4a-7211-9241-152432678986/research-ai-recommendation-designs.html`.
The mockup's names, papers, and explanations are fictional design examples,
not live model recommendations. The feature should describe research-topic fit;
supervision availability is not established by paper similarity. Connecting paper
relevance to researchers requires the verified paper-author mapping.

**Status: Paper Trail is implemented, browser-tested, and connected locally.**
The user authorized preparation during training, then continuing to integration
on 2026-11-04 (Pacific/Auckland). Both full epochs, held-out proxy evaluation,
the selected-model paper index, and live query/author-link checks are complete.
See [Recommendation API and activation](neural-service.md) for the contract, tests,
background finalization, and activation instructions.

## Prototype roadmap: Version 2 field weighting and full text

Decision recorded on **2026-11-03 (Pacific/Auckland)** at the user's request.
Keep the following enhancements for **Version 2** and include this decision in
the final prototype documentation under **Future work / Version 2 roadmap**.
These are planned experiments, not implemented features or measured improvements.

### Version 1 scope

The initial neural-search design uses one paper representation built from its
title, keywords, and available abstract. No explicit per-field weighting is
assigned. Concatenating these fields does not imply equal field contributions,
and Transformer attention weights are not fixed field-weight percentages.
The current saved corpus contains no full paper bodies. The neural implementation
is being built step by step; this section records its agreed scope.

### Deferred Version 2 experiments

- **Field weighting:** encode title and abstract separately and combine their
  query-similarity scores with explicit weights. Extend to body evidence when
  full text is available. Choose weights using validation queries rather than
  assuming an optimal title/abstract/body ratio.
- **Full-text retrieval:** split available paper bodies into sections or chunks
  that fit the encoder's token budget, then evaluate how chunk scores should
  contribute to paper ranking. A relevant paper does not make every chunk a
  positive training example for the query.
- **Controlled comparison:** compare title-only, the Version 1 combined text,
  separate field scores, and chunk-based full-text retrieval. Handle missing
  fields explicitly and keep final test queries out of tuning and training.

The motivation is to investigate whether separating fields or adding detailed
body evidence improves relevance for different query types, such as broad-topic
search versus methodology or experimental-detail search. Any benefit must be
established through evaluation. Application integration remains a later joint
step with the user.
