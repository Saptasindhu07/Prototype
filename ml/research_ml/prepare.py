"""Starter queries: independently verified lookup oracles and UNLABELED topics."""

from .data import fingerprint, normalize_identifier, eligible


def prepare_benchmark(corpus):
    queries = []

    def split(group):
        return "test" if int(fingerprint(group)[:8], 16) % 4 == 0 else "dev"

    def lookup(text, kind, group, qid, filters=None):
        filters = filters or {}
        value = normalize_identifier(text)
        positives = {doc["id"]: 3 for doc in corpus["documents"]
                     if eligible(doc, kind, filters) and
                     value in [normalize_identifier(v) for v in doc["identifiers"].values()]}
        return {"id": qid, "group": group, "split": split(group), "kind": kind,
                "text": text, "filters": filters, "task": "lookup" if positives else "no_match",
                "judgment_scope": "complete", "judgment_source": "rule_based",
                "oracle": {"type": "exact_identifier"}, "qrels": positives}

    for kind, count, preferred in [("publications", 6, ("doi", "openAlex")),
                                    ("researchers", 4, ("orcid", "openAlex"))]:
        documents = sorted([doc for doc in corpus["documents"] if doc["kind"] == kind],
                           key=lambda doc: fingerprint(doc["id"]))
        selected = 0
        for doc in documents:
            value = next((doc["identifiers"][key] for key in preferred if doc["identifiers"].get(key)), None)
            if not value:
                continue
            selected += 1
            group = "identifier:" + value
            queries.append(lookup(value, kind, group, f"lookup-{kind}-{selected}"))
            if kind == "publications" and value.startswith("10."):
                queries.append(lookup("https://doi.org/" + value, kind, group,
                                      f"lookup-{kind}-{selected}-url"))
            if selected >= count:
                break
    topics = [("machine-learning", "machine learning"), ("neural-imaging", "neural networks for medical imaging"),
              ("proteins", "protein folding"), ("antimicrobial", "antimicrobial resistance"),
              ("quantum", "quantum information"), ("stars", "stellar evolution"),
              ("marine", "marine ecosystems"), ("earth", "earthquake fault mechanics")]
    for group, text in topics:
        for kind in ("publications", "researchers"):
            queries.append({"id": f"topic-{group}-{kind}", "group": "topic:" + group,
                            "split": split("topic:" + group), "kind": kind, "text": text,
                            "filters": {}, "task": "ranking", "judgment_scope": "pending",
                            "judgment_source": "pending", "qrels": {},
                            "judgment_notes": "Starter topic only. Human review and pooling required before relevance scoring."})
    missing = "10.9999/benchmark-unassigned-" + corpus["fingerprint"][:16]
    queries.append(lookup(missing, "publications", "missing-identifier", "lookup-missing-identifier"))
    return {"schema_version": 1, "name": "Research discovery pilot v1",
            "corpus_fingerprint": corpus["fingerprint"],
            "description": "Exact identifier correctness controls plus unjudged topic queries. Not a labeled semantic benchmark.",
            "queries": queries}
