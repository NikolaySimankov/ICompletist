"""
Google Scholar – search via SerpApi.
"""

import re
import time
from typing import List, Dict, Optional

import serpapi

_BATCH_SIZE = 20  # SerpApi Google Scholar page size (max 20)


def build_scholar_query(spec: dict) -> str:
    """
    Build a Google Scholar query string from a spec dict.

    Same spec structure as build_pubmed_query() / build_scopus_query(), but
    produces Google Scholar syntax:
        ("term" OR "term")  for inclusive groups
        -"term" -"term"     for excluded terms  (external: "NOT")

    Note: Google Scholar year filtering is an API parameter, not a query token.
    year_from / year_to in the spec are intentionally ignored here; pass them
    directly to search_scholar() or ICompletist.search_scholar().

    spec:
        year_from : int – ignored (pass to search_scholar instead)
        year_to   : int – ignored (pass to search_scholar instead)
        groups    : list of group dicts, each with:
                      terms    : list[str]
                      internal : "OR" | "AND" – logic between terms in the group
                      external : "AND" | "NOT" – how this group joins the preceding
                                 query; omit or None for the first group
    """
    groups = spec["groups"]
    parts = []

    for group in groups:
        external = group.get("external")
        internal = group.get("internal", "OR")
        terms = group["terms"]

        if external in ("NOT", "AND NOT"):
            # Google Scholar negation: prefix each term individually with -
            parts.append(" ".join(f'-"{t}"' for t in terms))
        else:
            quoted = [f'"{t}"' for t in terms]
            sep = " OR " if internal == "OR" else " "
            parts.append("(" + sep.join(quoted) + ")")

    return " ".join(parts)


def search_scholar(
    query: str,
    limit: int = 100,
    api_key: str = "",
    lang: str = "en",
    review_only: bool = False,
    year_from: Optional[int] = None,
    year_to: Optional[int] = None,
) -> List[Dict]:
    """
    Search Google Scholar via SerpApi.
    Returns a list of article dicts.

    Each dict contains:
        result_id, title, link, snippet, authors, publication_info,
        year, cited_by, cited_by_link, versions, pdf_link
    """
    client = serpapi.Client(api_key=api_key)
    articles = []

    print(f"    Query: {query[:80]}...")

    for start in range(0, limit, _BATCH_SIZE):
        params = {
            "engine": "google_scholar",
            "q": query,
            "hl": lang,
            "start": start,
            "num": min(_BATCH_SIZE, limit - start),
        }

        if review_only:
            params["as_rr"] = "1"
        if year_from is not None:
            params["as_ylo"] = year_from
        if year_to is not None:
            params["as_yhi"] = year_to

        try:
            results = client.search(params)
            entries = results.get("organic_results", [])

            if not entries:
                break

            for entry in entries:
                pub_info = entry.get("publication_info", {})
                summary = pub_info.get("summary", "")

                # Extract 4-digit year from summary string
                year_match = re.search(r"\b(19|20)\d{2}\b", summary)
                year = int(year_match.group()) if year_match else None

                # First PDF resource, if any
                pdf_link = next(
                    (
                        r.get("link")
                        for r in entry.get("resources", [])
                        if r.get("file_format", "").upper() == "PDF"
                    ),
                    None,
                )

                inline = entry.get("inline_links", {})
                cited_by = inline.get("cited_by", {})
                versions = inline.get("versions", {})

                articles.append(
                    {
                        "result_id": entry.get("result_id"),
                        "title": entry.get("title"),
                        "link": entry.get("link"),
                        "snippet": entry.get("snippet"),
                        "authors": [a.get("name") for a in pub_info.get("authors", [])],
                        "publication_info": summary,
                        "year": year,
                        "cited_by": cited_by.get("total"),
                        "cited_by_link": cited_by.get("link"),
                        "versions": versions.get("total"),
                        "pdf_link": pdf_link,
                    }
                )

            total_raw = results.get("search_information", {}).get("total_results", "")
            total_str = f"/{total_raw}" if total_raw else ""
            print(
                f"      Retrieved {len(articles)}{total_str} articles"
                f" (batch {start // _BATCH_SIZE + 1})"
            )

            # Stop early if the page returned fewer results than requested
            if len(entries) < _BATCH_SIZE:
                break

            time.sleep(0.5)  # stay within SerpApi rate limits

        except Exception as e:
            print(f"      ⚠️  Scholar error at start={start}: {e}")
            continue

    print(f"    ✓ Found {len(articles)} articles on Google Scholar")
    return articles
