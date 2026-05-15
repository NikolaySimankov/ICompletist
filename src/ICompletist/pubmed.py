"""
Part 2 – PubMed search and article metadata fetching.
"""

import requests
import xml.etree.ElementTree as ET
import html
import time
from typing import List, Dict, Optional

from .pdf import normalize_pmcid, get_pdf


def build_pubmed_query(
    common_names: List[str],
    keywords1: List[str],
    keywords2: List[str],
    exceptions: List[str],
) -> str:
    """
    Build standardized PubMed query using proper field syntax.
    """
    # Build plant search terms
    plant_terms = [f'"{name}"[All Fields]' for name in common_names]
    plant_part = "(" + " OR ".join(plant_terms) + ")"

    # Build keyword search terms
    keyword1_terms = [f'"{kw}"[All Fields]' for kw in keywords1]
    keyword1_part = "(" + " OR ".join(keyword1_terms) + ")"

    # Build secondary keyword search terms
    keyword2_terms = [f'"{kw}"[All Fields]' for kw in keywords2]
    keyword2_part = "(" + " OR ".join(keyword2_terms) + ")"

    exception_terms = [f'"{kw}"[All Fields]' for kw in exceptions]
    exception_part = "(" + " AND ".join(exception_terms) + ")"

    query = f"{plant_part} AND {keyword1_part} AND {keyword2_part} NOT {exception_part}"
    return query


def search_pubmed(
    query: str,
    limit: int = 20000,
    email: str = "research@example.com",
) -> List[str]:
    """
    Search PubMed via NCBI Entrez ESearch API.
    Returns list of PMIDs.
    """
    base_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    pmids = []

    print(f"    Query: {query[:50]}...")

    # Fetch in batches
    for retstart in range(0, limit, 5000):
        params = {
            "db": "pubmed",
            "term": query,
            "retmax": min(5000, limit - retstart),
            "retstart": retstart,
            "retmode": "json",
            "email": email,
            "api_key": "b845a525f9db4f0c0148206bced6b07c7408",
        }

        try:
            response = requests.get(base_url, params=params, timeout=30)
            response.raise_for_status()
            data = response.json()

            batch_pmids = data.get("esearchresult", {}).get("idlist", [])
            pmids.extend(batch_pmids)

            if batch_pmids:
                print(
                    f"      Retrieved {len(batch_pmids)} PMIDs (batch {retstart//5000 + 1})"
                )

            # Respect rate limits
            time.sleep(0.1)

            if len(pmids) >= limit:
                break

        except Exception as e:
            print(f"      ⚠️  PubMed error at retstart={retstart}: {e}")
            continue

    print(f"    ✓ Found {len(pmids)} articles on PubMed")
    return pmids[:limit]


def extract_text_from_element(elem) -> str:
    """
    Extract all text from an element, including text in child elements.
    This handles nested formatting tags like <i>, <sub>, <sup>.
    """
    if elem is None:
        return ""

    # Get all text content including from child elements
    text_parts = []

    # Add the main text
    if elem.text:
        text_parts.append(elem.text)

    # Add text from child elements (handles <i>, <sub>, <sup>, etc.)
    for child in elem:
        if child.text:
            text_parts.append(child.text)
        if child.tail:
            text_parts.append(child.tail)

    # Join and decode HTML entities
    full_text = "".join(text_parts)
    full_text = html.unescape(full_text)

    # Clean up whitespace and special characters
    full_text = full_text.replace("\xa0", " ")  # Non-breaking space
    full_text = " ".join(full_text.split())  # Normalize whitespace

    return full_text.strip()


def fetch_article_data(
    pmids: List[str], email: str = "research@example.com", path: Optional[str] = "."
) -> List[Dict]:
    """
    Fetch article data (title, abstract, year, DOI, sections) from NCBI EFetch.
    """
    base_url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    articles = []

    # Process in batches (max 200 per request)
    for i in range(0, len(pmids), 200):
        batch_pmids = pmids[i : i + 200]

        params = {
            "db": "pubmed",
            "id": ",".join(batch_pmids),
            "rettype": "abstract",
            "retmode": "xml",
            "email": email,
            "api_key": "b845a525f9db4f0c0148206bced6b07c7408",
        }

        try:
            response = requests.get(base_url, params=params, timeout=30)
            response.raise_for_status()

            # Parse XML
            root = ET.fromstring(response.content)

            for article_elem in root.findall(".//PubmedArticle"):

                # Extract title - use improved text extraction
                title_elem = article_elem.find(".//ArticleTitle")
                title = extract_text_from_element(title_elem)

                # Extract abstract - handle multiple AbstractText sections
                abstract_parts = []
                for abstract_text_elem in article_elem.findall(
                    ".//Abstract/AbstractText"
                ):
                    text = extract_text_from_element(abstract_text_elem)
                    if text:
                        abstract_parts.append(text)
                abstract = " ".join(abstract_parts)

                # Extract year
                year_elem = article_elem.find(".//PubDate/Year")
                year = (
                    int(year_elem.text)
                    if year_elem is not None and year_elem.text.isdigit()
                    else None
                )

                pubmed_data = article_elem.find("PubmedData")
                if pubmed_data is not None:
                    article_ids = {
                        aid.get("IdType"): aid.text
                        for aid in pubmed_data.findall("ArticleIdList/ArticleId")
                    }

                # # Extract DOI
                pmid = article_ids.get("pubmed")
                pmcid = article_ids.get("pmc")
                pmcid = normalize_pmcid(pmcid) if pmcid else None
                doi = article_ids.get("doi")
                pii = article_ids.get("pii")

                article_data = {
                    "pmid": pmid,
                    "pmcid": pmcid or None,
                    "pii": pii or None,
                    "source_doi": doi or None,
                    "source_url": f"https://www.ncbi.nlm.nih.gov/pubmed/{pmid}",
                    "title": title,
                    "abstract": abstract,
                    "year": year,
                }

                try:
                    file = get_pdf(pmcid, doi, pmid, path)

                    # Merge filepath into article_data
                    article_data.update(file)

                except Exception as e:
                    print(f"      ⚠️  Fetch error for PMID : {pmid}: {e}")
                    pass

                articles.append(article_data)

            if articles:
                print(f"      Fetched {len(articles)} articles (batch {i//200 + 1})")

            # Respect rate limits
            time.sleep(0.1)

        except Exception as e:
            print(f"      ⚠️  Fetch error for batch starting at {i}: {e}")
            continue

    print(f"    ✓ Fetched metadata for {len(articles)} articles")
    return articles
