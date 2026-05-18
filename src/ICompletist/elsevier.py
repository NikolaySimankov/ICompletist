"""
Elsevier / Scopus API – search and article metadata fetching.
"""

import requests
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Optional

_BASE_URL = "https://api.elsevier.com/content/search/scopus"
_ABSTRACT_URL = "https://api.elsevier.com/content/abstract/scopus_id/{}"
# 25 = hard ceiling for standard API keys; raise to 200 with institutional access
_BATCH_SIZE = 200


def build_scopus_query(spec: dict) -> str:
    """
    Build a Scopus boolean query string from a spec dict.

    Same structure as build_pubmed_query() but produces Scopus field-operator syntax:
        FIELD("term")  instead of  "term"[FIELD]

    spec:
        field     : Scopus field operator for groups that don't override it
                    (default "ALL"). Common values:
                      "ALL"            – all fields
                      "TITLE-ABS-KEY"  – title, abstract, keywords
                      "TITLE"          – title only
        year_from : int – earliest publication year (inclusive)
        year_to   : int – latest publication year (inclusive)
        groups    : list of group dicts, each with:
                      terms    : list[str]
                      field    : optional per-group field override
                      internal : "OR" | "AND"  – logic between terms in the group
                      external : "AND" | "OR" | "AND NOT" – how this group joins
                                 the preceding query; omit or None for the first group
    """
    default_field = spec.get("field", "TITLE-ABS-KEY")
    groups = spec["groups"]

    def _render(group):
        op = group.get("internal", "OR")
        f = group.get("field", default_field)
        tagged = [f'{f}("{t}")' for t in group["terms"]]
        return "(" + f" {op} ".join(tagged) + ")"

    query = _render(groups[0])
    for group in groups[1:]:
        external = group.get("external", "AND")
        if external == "NOT":  # normalise to Scopus convention
            external = "AND NOT"
        query = f"{query} {external} {_render(group)}"

    # Scopus only supports strict > / <, so shift by 1 to make the range inclusive
    if year_from := spec.get("year_from"):
        query += f" AND PUBYEAR > {year_from - 1}"
    if year_to := spec.get("year_to"):
        query += f" AND PUBYEAR < {year_to + 1}"

    return query


def search_scopus(
    query: str,
    limit: int = 10000,
    api_key: str = "",
    email: str = "research@example.com",
) -> List[Dict]:
    """
    Search Scopus via the Elsevier Scopus Search API.
    Returns a list of article dicts.

    Each dict contains:
        scopus_id, eid, pmid, doi, title, abstract,
        year, journal, volume, pages, cited_by,
        open_access, article_type, source_url
    """
    articles = []

    print(f"    Query: {query[:80]}...")

    for start in range(0, limit, _BATCH_SIZE):
        params = {
            "query": query,
            "apiKey": api_key,
            "httpAccept": "application/json",
            "start": start,
            "count": min(_BATCH_SIZE, limit - start),
        }

        try:
            response = requests.get(_BASE_URL, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            results = data.get("search-results", {})
            total = int(results.get("opensearch:totalResults", 0))
            entries = results.get("entry", [])

            # API returns a single error-keyed entry when there are no results
            if not entries or "error" in entries[0]:
                break

            for entry in entries:
                raw_date = entry.get("prism:coverDate", "")
                year = (
                    int(raw_date[:4]) if raw_date and raw_date[:4].isdigit() else None
                )

                eid = entry.get("eid")
                articles.append(
                    {
                        "scopus_id": entry.get("dc:identifier", "").replace(
                            "SCOPUS_ID:", ""
                        ),
                        "eid": eid,
                        "pmid": entry.get("pubmed-id"),
                        "doi": entry.get("prism:doi"),
                        "title": entry.get("dc:title"),
                        "abstract": entry.get("dc:description"),
                        "year": year,
                        "journal": entry.get("prism:publicationName"),
                        "volume": entry.get("prism:volume"),
                        "pages": entry.get("prism:pageRange"),
                        "cited_by": entry.get("citedby-count"),
                        "open_access": entry.get("openaccessFlag") == "true",
                        "article_type": entry.get("subtypeDescription"),
                        "source_url": (
                            f"https://www.scopus.com/record/display.uri?eid={eid}"
                            if eid
                            else None
                        ),
                    }
                )

            print(
                f"      Retrieved {len(articles)}/{total} articles"
                f" (batch {start // _BATCH_SIZE + 1})"
            )

            if len(articles) >= min(total, limit):
                break

            time.sleep(0.1)

        except Exception as e:
            print(f"      ⚠️  Scopus error at start={start}: {e}")
            continue

    print(f"    ✓ Found {len(articles)} articles on Scopus")
    return articles


def fetch_scopus_abstract(scopus_id: str, api_key: str = "") -> Optional[str]:
    """
    Fetch the full abstract for a single article via the Abstract Retrieval API.
    Returns the abstract string, or None if unavailable.
    """
    url = _ABSTRACT_URL.format(scopus_id)
    params = {"httpAccept": "application/json", "apiKey": api_key}
    try:
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()
        data = response.json()
        return (
            data.get("abstracts-retrieval-response", {})
            .get("coredata", {})
            .get("dc:description")
        )
    except Exception:
        return None


def enrich_scopus_abstracts(
    articles: List[Dict],
    api_key: str = "",
    only_missing: bool = True,
    max_workers: int = 5,
) -> List[Dict]:
    """
    Fetch full abstracts via the Abstract Retrieval API (one request per article)
    using concurrent requests to minimise wall time.

    only_missing=True (default) skips articles that already have an abstract.
    max_workers controls concurrency (default 5 — safe for standard API keys).
    """
    targets = [
        a
        for a in articles
        if a.get("scopus_id") and (not only_missing or not a.get("abstract"))
    ]

    if not targets:
        return articles

    print(
        f"    Fetching abstracts for {len(targets)}/{len(articles)} articles"
        f" ({max_workers} concurrent)..."
    )

    done = 0

    def _fetch(article):
        abstract = fetch_scopus_abstract(article["scopus_id"], api_key)
        if abstract:
            article["abstract"] = abstract

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_fetch, a): a for a in targets}
        for future in as_completed(futures):
            future.result()
            done += 1
            if done % 25 == 0:
                print(f"      {done}/{len(targets)}")

    print("    ✓ Abstract enrichment complete")
    return articles


def search_scopus_articles(
    query: str,
    limit: int = 10000,
    api_key: str = "",
    email: str = "research@example.com",
    max_workers: int = 5,
) -> List[Dict]:
    """Search Scopus and enrich with full abstracts in one call."""
    articles = search_scopus(query, limit=limit, api_key=api_key, email=email)
    return enrich_scopus_abstracts(articles, api_key=api_key, max_workers=max_workers)
