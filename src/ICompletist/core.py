"""
ICompletist – unified search client for PubMed, Scopus, and Google Scholar.
"""

import json
from pathlib import Path
from typing import List, Dict, Optional, Union

from .pubmed import (
    search_pubmed_articles as _search_pubmed_articles,
    fetch_article_data as _fetch_article_data,
)
from .elsevier import (
    search_scopus_articles as _search_scopus_articles,
    enrich_scopus_abstracts as _enrich_scopus_abstracts,
)
from .scholar import search_scholar as _search_scholar


def select_articles(articles: List[Dict], spec: dict) -> List[Dict]:
    """Filter *articles* using the same spec dict logic as the query builders.

    Each article's title and abstract are searched (case-insensitive).

    spec groups:
        terms    : list[str] – keywords to look for
        internal : "OR" | "AND"  – how terms combine inside a group (default OR)
        external : "AND" | "OR" | "NOT" | "AND NOT" – how this group joins the
                   preceding result; omit or None for the first group
    """

    def _match_group(text: str, group: dict) -> bool:
        internal = group.get("internal", "OR")
        terms = group["terms"]
        if internal == "AND":
            return all(t.lower() in text for t in terms)
        return any(t.lower() in text for t in terms)

    def _matches(article: Dict) -> bool:
        text = " ".join(
            filter(
                None,
                [
                    article.get("title") or "",
                    article.get("abstract") or "",
                    article.get("snippet") or "",
                ],
            )
        ).lower()

        groups = spec["groups"]
        result = _match_group(text, groups[0])
        for group in groups[1:]:
            external = (group.get("external") or "AND").upper()
            match = _match_group(text, group)
            if external in ("NOT", "AND NOT"):
                result = result and not match
            elif external == "OR":
                result = result or match
            else:  # AND
                result = result and match
        return result

    return [a for a in articles if _matches(a)]


class ICompletist:
    """
    Unified search client.

    Results from all searches are accumulated in ``self._articles`` (keyed by DOI).
    Scopus data always takes priority: merging a Scopus result overwrites any
    existing non-null field.  PubMed / Scholar results only fill null gaps.

    Parameters
    ----------
    email : str
        Contact email – required by the NCBI Entrez usage policy.
    pubmed_api_key : str
        NCBI API key (raises rate limit from 3 to 10 req/s).
    elsevier_api_key : str
        Elsevier / Scopus API key.
    serpapi_api_key : str
        SerpApi key for Google Scholar.
    """

    def __init__(
        self,
        email: str,
        pubmed_api_key: str = "",
        elsevier_api_key: str = "",
        serpapi_api_key: str = "",
    ):
        self.email = email
        self.pubmed_api_key = pubmed_api_key
        self.elsevier_api_key = elsevier_api_key
        self.serpapi_api_key = serpapi_api_key
        # Internal store: DOI (lower-cased) → merged article dict.
        # Articles without a DOI use a synthetic "_no_doi_<id>" key.
        self._articles: Dict[str, Dict] = {}

    # ------------------------------------------------------------------ merge

    @staticmethod
    def _doi_key(article: Dict) -> str:
        doi = (article.get("doi") or article.get("source_doi") or "").strip().lower()
        if doi:
            return doi
        fallback = (
            article.get("pmid")
            or article.get("scopus_id")
            or article.get("result_id")
            or str(id(article))
        )
        return f"_no_doi_{fallback}"

    def _merge(self, new_articles: List[Dict], source: str) -> None:
        """Merge *new_articles* into the internal store using DOI as the join key.

        Scopus is authoritative: its non-null values always win.
        PubMed / Scholar values only fill fields that are currently null.
        """
        for article in new_articles:
            key = self._doi_key(article)
            article = {**article, "_source": source}

            if key not in self._articles:
                self._articles[key] = article
                continue

            existing = self._articles[key]
            if source == "scopus":
                # Scopus overwrites any non-null field
                for k, v in article.items():
                    if v is not None:
                        existing[k] = v
                existing["_source"] = "scopus"
            else:
                # Other sources only fill gaps left by the primary source
                for k, v in article.items():
                    if existing.get(k) is None and v is not None:
                        existing[k] = v

    @property
    def articles(self) -> List[Dict]:
        """Deduplicated articles accumulated across all searches (list of dicts)."""
        return list(self._articles.values())

    def get(self, doi: str) -> Optional[Dict]:
        """Return the article dict for *doi*, or None if not found."""
        return self._articles.get(doi.strip().lower())

    def load(self, source: Union[str, Path, List[Dict]]) -> None:
        """Import articles from a previous run into the store.

        *source* can be:
          - a file path (str or Path) pointing to a JSON file containing List[Dict]
          - a List[Dict] already loaded in memory
        """
        if isinstance(source, (str, Path)):
            with open(source, "r", encoding="utf-8") as f:
                articles = json.load(f)
        else:
            articles = source

        source_label = next(
            (a["_source"] for a in articles if "_source" in a), "imported"
        )
        self._merge(articles, source_label)
        print(f"    ✓ Loaded {len(articles)} articles into the store")

    def select(self, spec: dict) -> List[Dict]:
        """Filter the internal store using a spec dict and return matching articles.

        Uses the same group/terms/internal/external logic as the query builders,
        applied as a text search on each article's title and abstract.
        """
        results = select_articles(self.articles, spec)
        print(f"    ✓ Selected {len(results)} articles matching the spec")
        return results

    def clear(self) -> None:
        """Reset the internal article store."""
        self._articles.clear()

    # ------------------------------------------------------------------ PubMed

    def search_pubmed(self, query: str, limit: int = 20000) -> List[Dict]:
        """Search PubMed, fetch full metadata + abstracts, and merge into the store."""
        if not self.pubmed_api_key:
            print(
                "pubmed_api_key is not compulsory to search PubMed but it makes the requests faster."
            )
        results = _search_pubmed_articles(
            query,
            limit=limit,
            email=self.email,
            api_key=self.pubmed_api_key,
        )
        self._merge(results, "pubmed")
        return results

    def fetch_pubmed(self, pmids: List[str]) -> List[Dict]:
        """Retrieve article metadata for a pre-collected list of PMIDs and merge into the store."""
        results = _fetch_article_data(
            pmids,
            email=self.email,
            api_key=self.pubmed_api_key,
        )
        self._merge(results, "pubmed")
        return results

    # ----------------------------------------------------------------- Scopus

    def search_scopus(
        self, query: str, limit: int = 5000, max_workers: int = 5
    ) -> List[Dict]:
        """Search Scopus, enrich with full abstracts, and merge into the store."""
        if not self.elsevier_api_key:
            raise ValueError("elsevier_api_key is required to search Scopus.")
        results = _search_scopus_articles(
            query,
            limit=limit,
            api_key=self.elsevier_api_key,
            email=self.email,
            max_workers=max_workers,
        )
        self._merge(results, "scopus")
        return results

    def enrich_scopus_abstracts(
        self,
        articles: List[Dict],
        only_missing: bool = True,
        max_workers: int = 5,
    ) -> List[Dict]:
        """Fetch full abstracts via the Abstract Retrieval API with concurrent requests.

        Mutates each article dict in-place and returns the list.
        only_missing=True (default) skips articles that already have an abstract.
        max_workers controls concurrency (default 5).
        """
        if not self.elsevier_api_key:
            raise ValueError("elsevier_api_key is required to fetch Scopus abstracts.")
        return _enrich_scopus_abstracts(
            articles,
            api_key=self.elsevier_api_key,
            only_missing=only_missing,
            max_workers=max_workers,
        )

    # --------------------------------------------------------- Google Scholar

    def search_scholar(
        self,
        query: str,
        limit: int = 100,
        review_only: bool = False,
        year_from: Optional[int] = None,
        year_to: Optional[int] = None,
        lang: str = "en",
        spec: Optional[dict] = None,
    ) -> List[Dict]:
        """Search Google Scholar via SerpApi and merge results into the store.

        year_from / year_to can be supplied directly or read from a spec dict
        (spec values are overridden by explicit arguments when both are given).
        """
        if not self.serpapi_api_key:
            raise ValueError("serpapi_api_key is required to search Google Scholar.")
        if spec:
            year_from = year_from if year_from is not None else spec.get("year_from")
            year_to = year_to if year_to is not None else spec.get("year_to")
        results = _search_scholar(
            query,
            limit=limit,
            api_key=self.serpapi_api_key,
            lang=lang,
            review_only=review_only,
            year_from=year_from,
            year_to=year_to,
        )
        self._merge(results, "scholar")
        return results
