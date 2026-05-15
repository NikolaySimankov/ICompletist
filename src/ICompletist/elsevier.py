"""
Elsevier / Scopus API – search and article metadata fetching.
"""

import requests
import time
from typing import List, Dict, Optional

_DEFAULT_API_KEY = "d226c24cefe9a52aca7ef3152b7ebb09"
_BASE_URL = "https://api.elsevier.com/content/search/scopus"
_BATCH_SIZE = 25


def build_scopus_query(spec: dict) -> str:
    """
    Build a Scopus boolean query string from a spec dict.

    Same structure as build_query() but produces Scopus field-operator syntax:
        FIELD("term")  instead of  "term"[FIELD]

    spec:
        field   : Scopus field operator for groups that don't override it
                  (default "ALL"). Common values:
                    "ALL"            – all fields
                    "TITLE-ABS-KEY"  – title, abstract, keywords
                    "TITLE"          – title only
        groups  : list of group dicts, each with:
                    terms    : list[str]
                    field    : optional per-group field override
                    internal : "OR" | "AND"  – logic between terms in the group
                    external : "AND" | "OR" | "AND NOT" – how this group joins
                               the preceding query; omit or None for the first group
    """
    default_field = spec.get("field", "ALL")
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

    return query


def search_scopus(
    query: str,
    limit: int = 20000,
    api_key: str = _DEFAULT_API_KEY,
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
