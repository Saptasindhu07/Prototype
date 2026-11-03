"""Read-only MongoDB export and immutable, portable search documents."""

from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re

KINDS = {"publications", "researchers"}
FILTERS = {"publications": {"department", "year_from", "year_to", "type"},
           "researchers": {"department"}}


def fingerprint(value):
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return sha256(encoded.encode("utf-8")).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value):
    """Never silently replace an existing snapshot, benchmark, or run."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def now():
    return datetime.now(timezone.utc).isoformat()


def normalize_identifier(value):
    value = value.strip().casefold()
    return re.sub(r"^(?:https?://(?:dx\.)?(?:doi\.org|orcid\.org|openalex\.org)/|doi:\s*|orcid:\s*)", "", value)


def make_corpus(documents, source, **metadata):
    documents = sorted(documents, key=lambda doc: doc["id"])
    corpus = {"schema_version": 1, "source": source, "created_at": now(),
              "documents": documents, "metadata": metadata}
    corpus["fingerprint"] = fingerprint(documents)
    validate_corpus(corpus)
    return corpus


def validate_corpus(corpus):
    if corpus.get("schema_version") != 1:
        raise ValueError("Unsupported corpus schema")
    documents = corpus.get("documents", [])
    if not documents or fingerprint(documents) != corpus.get("fingerprint"):
        raise ValueError("Empty corpus or corpus fingerprint mismatch")
    ids = set()
    for doc in documents:
        if not isinstance(doc.get("id"), str) or not doc["id"] or doc["id"] in ids:
            raise ValueError("Missing or duplicate document ID")
        ids.add(doc["id"])
        if doc.get("kind") not in KINDS:
            raise ValueError("Invalid document kind")
        if not all(isinstance(doc.get(key), str) for key in ("title", "text")):
            raise ValueError("Document title/text must be strings")
        if not isinstance(doc.get("identifiers"), dict) or not isinstance(doc.get("metadata"), dict):
            raise ValueError("Document identifiers and metadata must be objects")
        if not all(isinstance(v, str) for v in doc["identifiers"].values()):
            raise ValueError("Identifiers must be strings")
    return corpus


def load_corpus(path):
    return validate_corpus(read_json(path))


def validate_filters(kind, filters):
    if not isinstance(filters, dict) or set(filters) - FILTERS[kind]:
        raise ValueError(f"Unsupported {kind} filters; allowed: {sorted(FILTERS[kind])}")
    for name, value in filters.items():
        if name.startswith("year_"):
            if type(value) is not int or not 1000 <= value <= 9999:
                raise ValueError("Year filters must be integer years")
        elif not isinstance(value, str) or not value.strip():
            raise ValueError("Text filters must be nonempty strings")
    if filters.get("year_from", 1000) > filters.get("year_to", 9999):
        raise ValueError("year_from exceeds year_to")


def eligible(doc, kind, filters):
    if doc["kind"] != kind:
        return False
    meta = doc["metadata"]
    if "department" in filters and filters["department"] not in meta.get("departments", []):
        return False
    if "type" in filters and filters["type"] != meta.get("type"):
        return False
    if "year_from" in filters or "year_to" in filters:
        year = meta.get("year")
        if type(year) is not int or not filters.get("year_from", 1000) <= year <= filters.get("year_to", 9999):
            return False
    return True


def documents_from_records(publications, researchers):
    """Exact DOI duplicates collapse; never merge by title or author name."""
    people = {str(person["_id"]): person for person in researchers}
    departments = {key: sorted({a["department"] for a in person.get("affiliations", [])
                               if a.get("department") and a.get("isCurrent", True)})
                   for key, person in people.items()}
    groups = defaultdict(list)
    for paper in publications:
        doi = normalize_identifier(paper.get("externalIds", {}).get("doi", ""))
        groups[("doi", doi) if doi else ("id", str(paper["_id"]))].append(paper)
    documents, by_person = [], defaultdict(list)
    for members in groups.values():

        members.sort(key=lambda p: (-bool(p.get("abstract")), str(p["_id"])))
        paper = members[0]
        author_ids = sorted({str(a["researcherId"]) for p in members for a in p.get("authors", [])
                             if a.get("researcherId") and str(a["researcherId"]) in people})
        text = "\n".join(filter(None, [paper.get("title", ""), " ".join(paper.get("keywords", [])),
                                      paper.get("abstract", "")]))
        doc = {"id": "publication:" + str(paper["_id"]), "kind": "publications",
               "title": paper.get("title", ""), "text": text,
               "identifiers": {k: normalize_identifier(v) for k, v in paper.get("externalIds", {}).items() if v},
               "metadata": {"mongo_ids": sorted(str(p["_id"]) for p in members),
                            "year": paper.get("year"), "type": paper.get("type", "other"),
                            "departments": sorted({d for key in author_ids for d in departments[key]}),
                            "researcher_ids": author_ids, "source_url": paper.get("sourceUrl", ""),
                            "abstract_available": bool(paper.get("abstract"))}}
        documents.append(doc)
        for key in author_ids:
            by_person[key].append(doc)
    for key, person in people.items():
        papers = sorted(by_person[key], key=lambda doc: doc["id"])

        text = "\n".join(filter(None, [person.get("name", ""), person.get("biography", ""),
                                      " ".join(person.get("researchInterests", [])),
                                      *(p["text"] for p in papers)]))
        documents.append({"id": "researcher:" + key, "kind": "researchers",
                          "title": person.get("name", ""), "text": text,
                          "identifiers": {k: normalize_identifier(v) for k, v in person.get("externalIds", {}).items() if v},
                          "metadata": {"mongo_ids": [key], "departments": departments[key],
                                       "publication_ids": [p["id"] for p in papers],
                                       "source_url": person.get("profileUrl", "")}})
    return documents


def export_mongodb(output, env_file=None):
    """SELECT-only export. No inserts, updates, index creation, or app imports."""
    import os
    from dotenv import load_dotenv
    from pymongo import MongoClient

    if env_file:
        load_dotenv(env_file, override=False)
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        raise ValueError("Set MONGODB_URI or supply --env-file; credentials are never exported")
    projections = {
        "publications": dict.fromkeys(["_id", "title", "abstract", "keywords", "authors", "externalIds",
                                       "year", "type", "sourceUrl"], 1),
        "researchers": dict.fromkeys(["_id", "name", "biography", "researchInterests", "affiliations",
                                      "externalIds", "profileUrl"], 1)}
    if Path(output).exists():
        raise FileExistsError("Snapshot already exists; choose a new versioned path")
    with MongoClient(uri, serverSelectionTimeoutMS=5000, socketTimeoutMS=30000,
                     appname="research-ml-readonly-snapshot") as client:
        db = client.get_default_database()
        if db is None:
            raise ValueError("MONGODB_URI must include a database name")

        def read():
            return {name: list(db[name].find({}, fields).sort("_id", 1).max_time_ms(30000))
                    for name, fields in projections.items()}

        records = read()


        canonical = lambda rows: json.loads(json.dumps(rows, default=str))
        source_hash = fingerprint(canonical(records))
        if fingerprint(canonical(read())) != source_hash:
            raise ValueError("Database changed during export; retry after import/update work finishes")
        documents = documents_from_records(**records)
        corpus = make_corpus(documents, "mongodb", database=db.name,
                             raw_counts={name: len(rows) for name, rows in records.items()},
                             source_content_hash=source_hash, consistency="two_matching_reads",
                             unit="exact-DOI-deduplicated publication or verified researcher profile",
                             department_semantics="current profile affiliations, not historical publication affiliations")
    write_json(output, corpus)
    return corpus
