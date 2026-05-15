"""
ICompletist – unified search client for PubMed, Scopus, and Google Scholar.
"""

from typing import List, Dict, Optional

from .pubmed import (
    search_pubmed as _search_pubmed,
    fetch_article_data as _fetch_article_data,
)
from .elsevier import (
    search_scopus as _search_scopus,
    fetch_scopus_abstract as _fetch_scopus_abstract,
    enrich_scopus_abstracts as _enrich_scopus_abstracts,
)
from .scholar import search_scholar as _search_scholar


class ICompletist:
    """
    Unified search client.

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

    # ------------------------------------------------------------------ PubMed

    def search_pubmed(self, query: str, limit: int = 20000) -> List[Dict]:
        """Search PubMed: fetch PMIDs then retrieve full article metadata."""
        if not self.pubmed_api_key:
            print(
                "pubmed_api_key is not compulsory to search PubMed but it makes the requests faster."
            )
        pmids = _search_pubmed(
            query,
            limit=limit,
            email=self.email,
            api_key=self.pubmed_api_key,
        )
        return _fetch_article_data(
            pmids,
            email=self.email,
            api_key=self.pubmed_api_key,
        )

    def fetch_pubmed(self, pmids: List[str]) -> List[Dict]:
        """Retrieve article metadata for a pre-collected list of PMIDs."""
        return _fetch_article_data(
            pmids,
            email=self.email,
            api_key=self.pubmed_api_key,
        )

    # ----------------------------------------------------------------- Scopus

    def search_scopus(self, query: str, limit: int = 5000) -> List[Dict]:
        """Search Scopus via the Elsevier API."""
        if not self.elsevier_api_key:
            raise ValueError("elsevier_api_key is required to search Scopus.")
        return _search_scopus(
            query,
            limit=limit,
            api_key=self.elsevier_api_key,
            email=self.email,
        )

    def enrich_scopus_abstracts(
        self,
        articles: List[Dict],
        only_missing: bool = True,
    ) -> List[Dict]:
        """Fetch full abstracts for Scopus articles via the Abstract Retrieval API.

        Mutates each article dict in-place and returns the list.
        only_missing=True (default) skips articles that already have an abstract.
        """
        if not self.elsevier_api_key:
            raise ValueError("elsevier_api_key is required to fetch Scopus abstracts.")
        return _enrich_scopus_abstracts(articles, api_key=self.elsevier_api_key, only_missing=only_missing)

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
        """Search Google Scholar via SerpApi.

        year_from / year_to can be supplied directly or read from a spec dict
        (spec values are overridden by explicit arguments when both are given).
        """
        if not self.serpapi_api_key:
            raise ValueError("serpapi_api_key is required to search Google Scholar.")
        if spec:
            year_from = year_from if year_from is not None else spec.get("year_from")
            year_to = year_to if year_to is not None else spec.get("year_to")
        return _search_scholar(
            query,
            limit=limit,
            api_key=self.serpapi_api_key,
            lang=lang,
            review_only=review_only,
            year_from=year_from,
            year_to=year_to,
        )
