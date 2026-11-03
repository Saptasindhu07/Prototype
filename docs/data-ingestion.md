## Otago dataset import

The import tools keep the existing Researcher/Publication schemas unchanged. Public
official directory/profile records are staged in ignored `work/otago/profiles.json`;
source snapshots, identity evidence, raw API responses and audit logs live under
`work/otago/`. These runtime files are not committed or exposed through the API.

Scope: School of Computing, Mathematics & Statistics, Biochemistry, Physics,
Chemistry, Microbiology & Immunology, Geology and Zoology. Publications must be
dated within the explicitly approved range and no later than collection day, with at least one verified
cohort author explicitly affiliated with Otago on the publication. The target is
up to 8,000 unique eligible publications, not a guarantee of source availability.
The original baseline starts in 2015. The user-requested expansion to 7,000+
records first extends the same verified cohort back to 2010, without adding units.
Set `OTAGO_FROM_DATE=2010-01-01` for that run; the default remains 2015.
After that range yielded 5,856 verified records, the user explicitly approved a
further expansion to `OTAGO_FROM_DATE=2005-01-01`, retaining the same cohort.
`OTAGO_CUTOFF` can freeze a prior collection day and otherwise uses Pacific/Auckland.
`OTAGO_TARGET` accepts 1–8,000. The exact range and target are frozen in the input
snapshot and status file; do not expand them further without user approval.

```powershell
npm.cmd run test:otago
npm.cmd run db:match:otago
npm.cmd run db:import:otago
node apps/api/scripts/enrich-otago.mjs
node apps/api/scripts/verify-otago.mjs
```

Do not run duplicate imports while a background job is active. `import.lock` and
`enrichment.lock` contain the owning process IDs. Investigate the process before
removing a stale lock. `run-otago-background.mjs` runs import then enrichment.

Matching requires official ORCID or exact name plus Otago affiliation and
corroborating official publication DOI/research-interest evidence. Ambiguous
matches remain in `author-matches.json` for review. Name-only matches are rejected.
DOI/OpenAlex identities deduplicate publications; authors retain source order,
and coauthors outside the verified cohort retain null `researcherId` references.
Source-reported dates are not independent verification of day-level precision.
OpenAlex keywords are enriched metadata, not necessarily author-supplied keywords.
Missing metadata is not fabricated; Semantic Scholar IDs remain absent unless sourced.

Review `status.json`, `enrichment-status.json`, `audit.jsonl` and
`enrichment-audit.jsonl` for progress, source provenance and field coverage.
Requests are cached and throttled; source access denials and quotas are not bypassed.
Crossref enrichment changes only missing fields on imported publications after
exact DOI/type checks. Metadata and abstract reuse rights depend on the source;
do not assume the entire combined dataset or all abstracts are unrestricted.

Run the read-only verifier only after both workers finish. It refuses active locks,
checks the frozen cohort and cached source author order, canonical identifier
duplicates, researcher links, date scope and field coverage, and prints a JSON
report without modifying MongoDB. A verified count below 8,000 is a scope outcome,
not a successful 8,000-record import; expanding scope requires a new user choice.

