"""
Standalone test script for ICompletist.
Run from the project root after: pip install -e .

    python test_icompletist.py
"""

import json
from pathlib import Path

from ICompletist import (
    ICompletist,
    build_pubmed_query,
    build_scopus_query,
    build_scholar_query,
)

# ── Configuration ─────────────────────────────────────────────────────────────

EMAIL = "nikolay.simankov@uliege.be"
PUBMED_API_KEY = "b845a525f9db4f0c0148206bced6b07c7408"
ELSEVIER_API_KEY = "d226c24cefe9a52aca7ef3152b7ebb09"
# SERPAPI_API_KEY = "fad594a2e6229aa5d6d24782051ae670962db47e9dc213edcc34d46522de61a3"

OUTPUT_DIR = Path("results")

LIMIT_PUBMED = 10000
LIMIT_SCOPUS = 5000
LIMIT_SCHOLAR = 100

# ── Client ────────────────────────────────────────────────────────────────────

client = ICompletist(
    email=EMAIL,
    pubmed_api_key=PUBMED_API_KEY,
    elsevier_api_key=ELSEVIER_API_KEY,
    # serpapi_api_key=SERPAPI_API_KEY,
)

# ── Run ───────────────────────────────────────────────────────────────────────

OUTPUT_DIR.mkdir(exist_ok=True)

subdir = OUTPUT_DIR / "ML_review"
subdir.mkdir(exist_ok=True)

# Shared query spec(same groups, different syntax per source)
spec = {
    "year_from": 2016,
    "year_to": 2026,
    "groups": [
        {
            "terms": [
                "vector prediction",
                "transmission",
                "virus-host",
                "reservoir",
                "host range",
                "host prediction",
                "host-virus",
            ],
            "internal": "OR",
        },
        {
            "terms": [
                "plant virology",
                "plant virus",
                "phytovirus",
                "phytovirology",
                "virology",
                "virus",
                "phage",
                "bacteriophage",
            ],
            "internal": "OR",
            "external": "AND",
        },
        {
            "terms": [
                "machine learning",
                "deep learning",
                "artificial intelligence",
            ],
            "internal": "OR",
            "external": "AND",
        },
    ],
}

# ── PubMed ────────────────────────────────────────────────────────────────

print("\n🔍 STEP 2a: Searching PubMed...")
pubmed_query = build_pubmed_query(spec)
pubmed_articles = client.search_pubmed(pubmed_query, limit=LIMIT_PUBMED)

with open(subdir / "pubmed.json", "w") as f:
    json.dump(pubmed_articles, f, indent=2)

print(f"    ✓ Saved {len(pubmed_articles)} articles → {subdir / 'pubmed.json'}")


# ── Scopus ────────────────────────────────────────────────────────────────

print("\n🔍 STEP 2b: Searching Scopus...")
scopus_query = build_scopus_query(spec)
scopus_articles = client.search_scopus(scopus_query, limit=LIMIT_SCOPUS)
# scopus_articles = client.enrich_scopus_abstracts(scopus_articles)

with open(subdir / "scopus.json", "w") as f:
    json.dump(scopus_articles, f, indent=2)

print(f"    ✓ Saved {len(scopus_articles)} articles → {subdir / 'scopus.json'}")

client.load(subdir / "scopus.json")

# ── Load ──────────────────────────────────────────────────────────────────

client.load(subdir / "ViroML.json")

spec2 = {
    "year_from": 2016,
    "year_to": 2026,
    "groups": [
        {
            "terms": [
                "vector prediction",
                "transmission",
                "virus-host",
                "reservoir",
                "host range",
                "host prediction",
                "host-virus",
            ],
            "internal": "OR",
        },
        {
            "terms": [
                "plant virology",
                "plant virus",
                "phytovirus",
                "phytovirology",
                # "virology",
                # "virus",
                # "phage",
                # "bacteriophage",
            ],
            "internal": "OR",
            "external": "AND",
        },
        {
            "terms": [
                "machine learning",
                "deep learning",
                "artificial intelligence",
            ],
            "internal": "OR",
            "external": "AND",
        },
    ],
}

articles = client.select(spec2)
