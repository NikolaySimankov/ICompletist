"""
Part 3 – High-level pipeline: names → PubMed search → article fetch.
"""

from typing import Dict, Optional

from .names import build_all_names_json
from .pubmed import build_pubmed_query, search_pubmed, fetch_article_data


def batch_extract_pubmed(
    plant_species: str,
    limit: int = 20000,
    email: str = "research@example.com",
    path: Optional[str] = ".",
) -> Dict:
    """
    MAIN FUNCTION: Search PubMed → Fetch metadata → Extract relationships
    """
    # Step 1: Auto-discover common names
    print("=" * 70)
    print("📚 STEP 1: Auto-discovering common names...")
    print("=" * 70)

    all_names = build_all_names_json(plant_species, email)

    # Step 2: Search PubMed for each plant
    print("\n" + "=" * 70)
    print("🔍 STEP 2: Searching PubMed and extracting relationships...")
    print("=" * 70)

    keywords1 = [
        # Core disease/pathogen terms
        "seed-born",
        "seed transmission",
        "seed transmited",
        "seed",
    ]

    keywords2 = [
        # Core disease/pathogen terms
        "virus",
        "viral",
        "phytovirus",
    ]

    exceptions = [
        "patent",
        "genome-editing",
        "transgenic",
        "CRISPR",
    ]

    print(f"\n🔍 Processing {plant_species}...")

    # Build and execute query
    query = build_pubmed_query(all_names, keywords1, keywords2, exceptions)
    query1 = query + " AND (1000/1/1:2015/1/1[pdat])"
    pmids1 = search_pubmed(query1, limit=limit, email=email)

    query = build_pubmed_query(all_names, keywords1, keywords2, exceptions)
    query2 = query + " AND (2015/1/1:2026/05/08[pdat])"
    pmids2 = search_pubmed(query2, limit=limit, email=email)

    # deduplicate PMIDs
    pmids = list(set(pmids1 + pmids2))
    print(f"    ✓ Found {len(pmids)} deduplicated articles on PubMed")

    # Fetch metadata
    articles = fetch_article_data(pmids, email=email, path=path)

    return articles
