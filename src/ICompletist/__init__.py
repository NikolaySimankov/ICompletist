"""
ICompletist – Plant-Pathogen DB: automated PubMed literature mining.
"""

from .core import ICompletist
from .names import get_common_names_from_wikidata
from .pubmed import (
    build_pubmed_query,
    search_pubmed,
    extract_text_from_element,
    fetch_article_data,
)
from .pdf import normalize_pmcid, get_pdf, get_pdf_pmc, get_pdf_doi, get_pdf_cell
from .pipeline import batch_extract_pubmed
from .elsevier import build_scopus_query, search_scopus
from .scholar import build_scholar_query, search_scholar

__all__ = [
    "ICompletist",
    "get_common_names_from_wikidata",
    "build_pubmed_query",
    "search_pubmed",
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
    "build_scholar_query",
    "search_scholar",
]
