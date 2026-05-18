"""
ICompletist – Plant-Pathogen DB: automated PubMed literature mining.
"""

from .core import ICompletist, select_articles
from .names import get_common_names_from_wikidata
from .pubmed import (
    build_pubmed_query,
    search_pubmed,
    extract_text_from_element,
    fetch_article_data,
    search_pubmed_articles,
)
from .get_pdf import get_pdf, get_pdf_pmc, get_pdf_doi, get_pdf_cell
from .elsevier import (
    build_scopus_query,
    search_scopus,
    fetch_scopus_abstract,
    enrich_scopus_abstracts,
    search_scopus_articles,
)
from .scholar import build_scholar_query, search_scholar

__all__ = [
    "ICompletist",
    "select_articles",
    "get_common_names_from_wikidata",
    "build_pubmed_query",
    "search_pubmed",
    "search_pubmed_articles",
    "extract_text_from_element",
    "fetch_article_data",
    "normalize_pmcid",
    "get_pdf",
    "get_pdf_pmc",
    "get_pdf_doi",
    "get_pdf_cell",
    "batch_extract_pubmed",
    "build_scopus_query",
    "search_scopus",
    "search_scopus_articles",
    "fetch_scopus_abstract",
    "enrich_scopus_abstracts",
    "build_scholar_query",
    "search_scholar",
]
