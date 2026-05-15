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

EMAIL = "nikolay.simankov@doct.uliege.be"
PUBMED_API_KEY = "b845a525f9db4f0c0148206bced6b07c7408"
# ELSEVIER_API_KEY = "d226c24cefe9a52aca7ef3152b7ebb09"
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
    serpapi_api_key=SERPAPI_API_KEY,
)

# ── Run ───────────────────────────────────────────────────────────────────────

OUTPUT_DIR.mkdir(exist_ok=True)

subdir = OUTPUT_DIR / "ML_review"
subdir.mkdir(exist_ok=True)

# Shared query spec (same groups, different syntax per source)
spec = {
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
                "prediction",
            ],
            "internal": "OR",
            "external": "AND",
        },
        {
            "terms": [
                "virus",
                "viral",
                "virology",
                "phytovirus",
                "riboviria",
                "plant virus",
            ],
            "internal": "OR",
            "external": "AND",
        },
    ],
}

# ── PubMed ────────────────────────────────────────────────────────────────
print("\n🔍 STEP 2a: Searching PubMed (split by date for full coverage)...")
base_query = build_pubmed_query(spec)
query_pre = base_query + " AND (1000/1/1:2015/1/1[pdat])"
query_post = base_query + " AND (2015/1/1:3000/1/1[pdat])"

from ICompletist import search_pubmed, fetch_article_data

pmids_pre = search_pubmed(
    query_pre, limit=LIMIT_PUBMED, email=EMAIL, api_key=PUBMED_API_KEY
)
pmids_post = search_pubmed(
    query_post, limit=LIMIT_PUBMED, email=EMAIL, api_key=PUBMED_API_KEY
)
pmids = list(set(pmids_pre + pmids_post))
print(f"    ✓ {len(pmids)} deduplicated PMIDs")

pubmed_articles = fetch_article_data(pmids, email=EMAIL, api_key=PUBMED_API_KEY)

with open(subdir / "pubmed.json", "w") as f:
    json.dump(pubmed_articles, f, indent=2)
print(f"    ✓ Saved {len(pubmed_articles)} articles → {subdir / 'pubmed.json'}")

# ── Scopus ────────────────────────────────────────────────────────────────
print("\n🔍 STEP 2b: Searching Scopus...")
scopus_query = build_scopus_query(spec)
scopus_articles = client.search_scopus(scopus_query, limit=LIMIT_SCOPUS)

with open(subdir / "scopus.json", "w") as f:
    json.dump(scopus_articles, f, indent=2)
print(f"    ✓ Saved {len(scopus_articles)} articles → {subdir / 'scopus.json'}")

# ── Google Scholar ────────────────────────────────────────────────────────
if SERPAPI_API_KEY:
    print("\n🔍 STEP 2c: Searching Google Scholar...")
    scholar_query = build_scholar_query(spec)
    scholar_articles = client.search_scholar(scholar_query, limit=LIMIT_SCHOLAR)

    with open(subdir / "scholar.json", "w") as f:
        json.dump(scholar_articles, f, indent=2)
    print(f"    ✓ Saved {len(scholar_articles)} articles → {subdir / 'scholar.json'}")
else:
    print("\n⚠️  STEP 2c: Skipping Google Scholar (SERPAPI_API_KEY not set).")

print(f"\n{'=' * 70}")
print("✅ COMPLETE!")
print(f"{'=' * 70}")
