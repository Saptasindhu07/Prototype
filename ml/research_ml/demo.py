"""Small fictional fully judged corpus, never presented as real quality evidence."""

from .data import make_corpus, documents_from_records


def demo_data():
    people = [{"_id": "r1", "name": "Example Imaging Researcher", "researchInterests": ["medical imaging"],
               "affiliations": [{"department": "Computing", "isCurrent": True}],
               "externalIds": {"openAlex": "A1001"}},
              {"_id": "r2", "name": "Example Marine Researcher", "researchInterests": ["marine ecosystems"],
               "affiliations": [{"department": "Zoology", "isCurrent": True}], "externalIds": {"openAlex": "A1002"}}]
    papers = [
        ("p1", "Deep learning for brain tumour segmentation in MRI", "Neural networks locate brain tumours in magnetic resonance scans.", "r1", 2024),
        ("p2", "Machine learning for brain tumour segmentation", "Traditional classifiers segment MRI images without deep neural networks.", "r1", 2020),
        ("p3", "Marine sediment analysis", "Ocean sediments and coastal ecosystems.", "r2", 2023),
        ("p4", "Introduction to neural networks", "General methods for classification and representation learning.", "r1", 2019),
        ("p5", "U-Net for brain tumour segmentation in MRI", "Deep convolutional networks segment magnetic resonance scans.", "r1", 2025),
        ("p6", "Coastal marine ecosystems", "Ocean biodiversity and ecosystem health.", "r2", 2024),
    ]
    records = [{"_id": key, "title": title, "abstract": abstract, "keywords": [], "year": year,
                "type": "journal-article", "externalIds": {"doi": "10.9999/example-" + key},
                "authors": [{"name": "Example Author", "researcherId": researcher}]}
               for key, title, abstract, researcher, year in papers]
    corpus = make_corpus(documents_from_records(records, people), "synthetic",
                         note="Fictional records for engineering verification only")

    def query(qid, text, qrels, kind="publications", **extra):
        return {"id": qid, "group": qid, "split": "dev", "kind": kind, "text": text,
                "filters": {}, "task": "ranking", "judgment_scope": "complete",
                "judgment_source": "synthetic", "qrels": qrels, **extra}

    queries = [
        query("imaging", "deep learning brain tumour segmentation MRI", {
            "publication:p1": 3, "publication:p2": 2, "publication:p4": 1, "publication:p5": 3}),
        query("marine", "marine ecosystems", {"publication:p3": 2, "publication:p6": 3}),
        query("imaging-person", "brain tumour segmentation", {"researcher:r1": 3}, "researchers"),
        query("marine-person", "coastal ecosystems", {"researcher:r2": 3}, "researchers"),
        query("recent-imaging", "brain tumour segmentation", {"publication:p1": 3, "publication:p5": 3},
              filters={"year_from": 2024, "department": "Computing"}),
        query("doi", "https://doi.org/10.9999/example-p1", {"publication:p1": 3}, task="lookup"),
        query("absent", "10.9999/absent-example", {}, task="no_match"),
    ]
    benchmark = {"schema_version": 1, "name": "Fictional engineering demo",
                 "corpus_fingerprint": corpus["fingerprint"], "queries": queries}
    return corpus, benchmark
