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
    get_common_names_from_wikidata,
)

# ── Configuration ─────────────────────────────────────────────────────────────

EMAIL = "nikolay.simankov@uliege.be"
PUBMED_API_KEY = "b845a525f9db4f0c0148206bced6b07c7408"
ELSEVIER_API_KEY = "6f487b578187bc934010e301da4a3f59"
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
    "year_from": 2010,
    "year_to": 2026,
    "groups": [
        {
            "terms": [
                "vector prediction",
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
                "machine learning",
                "deep learning",
                "artificial intelligence",
            ],
            "internal": "OR",
            "external": "AND",
        },
        {
            "terms": [
                "plant virology",
                "plant virus",
                "phytovirus",
                "phytovirology",
            ],
            "internal": "OR",
            "external": "AND",
        },
    ],
}

# ── Scopus ────────────────────────────────────────────────────────────────
print("\n🔍 STEP 2b: Searching Scopus...")
scopus_query = build_scopus_query(spec)
scopus_articles = client.search_scopus(scopus_query, limit=LIMIT_SCOPUS)

with open(subdir / "scopus.json", "w") as f:
    json.dump(scopus_articles, f, indent=2)
print(f"    ✓ Saved {len(scopus_articles)} articles → {subdir / 'scopus.json'}")
