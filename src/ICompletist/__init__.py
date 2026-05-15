"""
ICompletist – Plant-Pathogen DB: automated PubMed literature mining.
"""

from .names import get_common_names_from_wikidata, build_all_names_json
from .pubmed import build_pubmed_query, search_pubmed, extract_text_from_element, fetch_article_data
from .pdf import normalize_pmcid, get_pdf, get_pdf_pmc, get_pdf_doi, get_pdf_cell
from .pipeline import batch_extract_pubmed

__all__ = [
    "get_common_names_from_wikidata",
    "build_all_names_json",
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
]
