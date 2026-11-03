"""Standalone lexical baseline. Does not call or replicate the app's literal-v1 API."""

from collections import Counter, defaultdict
from math import isfinite, log
import re
from .data import eligible, normalize_identifier, validate_filters, KINDS

TOKENIZER_VERSION = "unicode-technical-v1"

TOKEN = re.compile(r"\w+(?:[-']\w+)*(?:\+\+|#)?", re.UNICODE)

STOP_WORDS = frozenset("a an the and or of to for in on with by from is are was were using".split())


def tokenize(text):
    return [word for word in TOKEN.findall(text.casefold()) if word not in STOP_WORDS]


class BM25Baseline:
    """Okapi BM25 with positive IDF, tf saturation and document-length normalization."""

    name = "independent-bm25-v1"

    def __init__(self, documents, k1=1.2, b=0.75):
        if not isfinite(k1) or not isfinite(b) or k1 <= 0 or not 0 <= b <= 1:
            raise ValueError("BM25 requires finite k1 > 0 and 0 <= b <= 1")
        self.k1, self.b = k1, b
        self.documents = {doc["id"]: doc for doc in documents}
        if len(self.documents) != len(documents):
            raise ValueError("Duplicate document IDs")
        self.postings = {kind: defaultdict(dict) for kind in KINDS}
        self.lengths, self.identifiers = {}, defaultdict(set)
        sizes, totals = Counter(), Counter()
        for doc in documents:
            terms = Counter(tokenize(doc["text"]))
            size = sum(terms.values())
            self.lengths[doc["id"]] = size
            sizes[doc["kind"]] += 1
            totals[doc["kind"]] += size
            for term, frequency in terms.items():
                self.postings[doc["kind"]][term][doc["id"]] = frequency
            for value in doc["identifiers"].values():
                self.identifiers[(doc["kind"], normalize_identifier(value))].add(doc["id"])
        self.sizes = sizes
        self.average_lengths = {kind: totals[kind] / sizes[kind] if sizes[kind] else 1 for kind in KINDS}

    @property
    def configuration(self):
        return {"k1": self.k1, "b": self.b, "tokenizer": TOKENIZER_VERSION,
                "stop_words": sorted(STOP_WORDS), "query_terms": "unique; OR matching",
                "idf": "log(1 + (N - df + 0.5)/(df + 0.5))",
                "tie_break": "document ID ascending", "identifier_lookup": "exact normalized ID"}

    def search(self, query, kind="publications", filters=None, k=50):
        if kind not in KINDS or type(k) is not int or k < 1:
            raise ValueError("Invalid record kind or retrieval depth")
        filters = filters or {}
        validate_filters(kind, filters)
        if not isinstance(query, str) or not query.strip():
            raise ValueError("Query must be nonempty text")
        normalized = normalize_identifier(query)
        looks_like_id = re.fullmatch(r"(?:10\.\d{4,9}/\S+|[aw]\d+|\d{4}-\d{4}-\d{4}-\d{3}[\dx])", normalized)
        if looks_like_id:
            return [{"id": doc_id, "score": 1.0} for doc_id in
                    sorted(self.identifiers.get((kind, normalized), []))
                    if eligible(self.documents[doc_id], kind, filters)][:k]
        scores = defaultdict(float)
        n = self.sizes[kind]
        avg = self.average_lengths[kind] or 1
        for term in sorted(set(tokenize(query))):
            posting = self.postings[kind].get(term, {})
            df = len(posting)
            idf = log(1 + (n - df + 0.5) / (df + 0.5))
            for doc_id, tf in posting.items():
                if not eligible(self.documents[doc_id], kind, filters):
                    continue
                denominator = tf + self.k1 * (1 - self.b + self.b * self.lengths[doc_id] / avg)
                scores[doc_id] += idf * tf * (self.k1 + 1) / denominator
        return [{"id": doc_id, "score": score}
                for doc_id, score in sorted(scores.items(), key=lambda item: (-item[1], item[0]))[:k]]
