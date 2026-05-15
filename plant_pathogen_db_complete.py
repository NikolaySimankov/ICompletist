#!/usr/bin/env python3
"""
Plant-Pathogen DB v2.2 - Complete Standalone Implementation
Fully automatic: Wikidata → PubMed → Abstracts + PDFs
"""

import requests
from urllib.parse import urlparse, unquote

import json
import xml.etree.ElementTree as ET
import html
import time
from datetime import datetime
from typing import List, Dict

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from pathlib import Path

from typing import Dict, List, Optional
from bs4 import BeautifulSoup

# ============================================================================
# PART 1: COMMON NAME DISCOVERY
# ============================================================================


def get_common_names_from_wikidata(
    scientific_name: str,
    email: str = "research@example.com",
) -> list:
    """Fetch from Wikidata - no API key needed"""
    try:
        headers = {"User-Agent": email}
        url = "https://www.wikidata.org/w/api.php"
        params = {
            "action": "wbsearchentities",
            "search": scientific_name,
            "language": "en",
            "format": "json",
        }
        response = requests.get(url, params=params, headers=headers, timeout=10)
        data = response.json()

        if not data.get("search"):
            return []

        entity_id = data["search"][0]["id"]
        entity_url = (
            f"https://www.wikidata.org/wiki/Special:EntityData/{entity_id}.json"
        )
        entity_response = requests.get(entity_url, headers=headers, timeout=10)
        entity_data = entity_response.json()

        entity = entity_data["entities"][entity_id]

        label = entity.get("labels", {}).get("en", {}).get("value")
        aliases = [a["value"] for a in entity.get("aliases", {}).get("en", [])]

        common_names = list(
            dict.fromkeys(name for name in [label] + aliases[:5] if name)
        )

        return list(set([scientific_name] + common_names))

    except Exception as e:
        print(f"  Wikidata error: {e}")
        return []


def build_all_names_json(
    plant_species: str,
    email: str = "research@example.com",
) -> List[str]:
    """
    Auto-discover all names for all plants and save to JSON.
    """

    print(f"  {plant_species}...", end=" ")

    # Try Wikidata first (free, fast)
    names = get_common_names_from_wikidata(plant_species, email)

    print(f"✓ Found {len(names)} names: {', '.join(names)}")

    return names


# ============================================================================
# PART 2: PUBMED SEARCH
# ============================================================================


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


def normalize_pmcid(pmcid):
    """
    Convertit un PMCID en format standard sans 'PMC'
    Exemple:
        PMC11370360 -> 11370360
        11370360 -> 11370360
    """
    pmcid = str(pmcid).strip().upper()

    if pmcid.startswith("PMC"):
        pmcid = pmcid[3:]

    return pmcid


def get_available_versions(s3_client, pmcid):
    """
    Récupère les versions disponibles d’un article PMC
    """
    prefix = f"PMC{pmcid}."

    response = s3_client.list_objects_v2(
        Bucket="pmc-oa-opendata", Prefix=prefix, Delimiter="/"
    )

    versions = []

    for cp in response.get("CommonPrefixes", []):
        folder = cp["Prefix"].rstrip("/")
        versions.append(folder)

    return versions


def is_pdf_bytes(content: bytes) -> bool:
    return content[:4] == b"%PDF"


def get_pdf_pmc(
    pmcid: str,
    filename: str,
) -> None:
    """
    Download the PDF file for a given PMCID from the PMC Open Access Subset.
    """

    pmcid = normalize_pmcid(pmcid)

    s3 = boto3.client(
        "s3", config=Config(signature_version=UNSIGNED), region_name="us-east-1"
    )

    versions = get_available_versions(s3, pmcid)

    if not versions:
        raise ValueError(f"No available versions found for PMC{pmcid}")
    version_folder = sorted(versions)[-1]

    pdf_filename = f"{version_folder}.pdf"

    s3_key = f"{version_folder}/{pdf_filename}"

    s3.download_file(
        Bucket="pmc-oa-opendata",
        Key=s3_key,
        Filename=filename,
    )


def get_pdf_cell(
    doi: str,
    filename: str,
) -> None:
    """
    Download the PDF file for a given DOI from Cell.
    """

    base_url = "https://cell.com"

    # Build full URL if it's a relative path
    html_url = base_url + "/" + doi
    response = requests.get(html_url)

    # Step 1 — Parse the HTML
    soup = BeautifulSoup(response.content, "html.parser")

    # Step 2 — Find the download link
    href = soup.select_one("div.download a")["href"]

    pdf_url = base_url + href
    response = requests.get(pdf_url)
    # Now use the extracted URL
    if is_pdf_bytes(response.content):
        with open(filename, "wb") as f:
            f.write(response.content)


def get_pdf_doi(
    doi: str,
    filename: str,
) -> None:
    """
    Download the PDF file for a given DOI from Sci-Hub.
    """
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    }

    doi_url = f"https://doi.org/{doi}"
    response = requests.get(
        doi_url,
        allow_redirects=True,
    )

    # Extract the domain
    domain = urlparse(response.url).netloc

    # Step 1 — Parse the HTML
    soup = BeautifulSoup(response.content, "html.parser")

    # springer
    if domain == "link.springer.com":
        pdf_tag = soup.find("meta", {"name": "citation_pdf_url"})
        pdf_url = pdf_tag["content"]

        # Now use the extracted URL
        response = requests.get(pdf_url, headers=headers)
        if is_pdf_bytes(response.content):
            with open(filename, "wb") as f:
                f.write(response.content)
        else:
            return pdf_url

    # apsjournals
    if domain == "apsjournals.apsnet.org":

        epdf_tag = soup.find("i", class_="icon-file-pdf")
        href = epdf_tag.find_parent("a")["href"]

        # Build full URL from a relative path
        epdf_url = "https://" + domain + href

        response = requests.get(epdf_url, headers)
        soup = BeautifulSoup(response.content, "html.parser")

        href = soup.find("a", {"class": "btn--bordered__light"})["href"]

        # Build full URL from a relative path
        pdf_url = "https://" + domain + href

        # Now use the extracted URL
        response = requests.get(pdf_url, headers=headers)
        if is_pdf_bytes(response.content):
            with open(filename, "wb") as f:
                f.write(response.content)
        else:
            return pdf_url


def get_pdf(
    pmcid: str,
    doi: str,
    pmid: Optional[str] = None,
    path: Optional[str] = ".",
) -> None:
    """
    Download a PDF file from a given URL.
    Try PMC first, then fallback to Sci-Hub if DOI is available.
    """

    Path(path).mkdir(parents=True, exist_ok=True)
    filename = Path(path) / f"{pmid}.pdf"

    # 1. PMC
    if pmcid:
        try:
            get_pdf_pmc(pmcid, str(filename))

            if filename.exists():
                return {"file_path": str(filename)}

        except Exception as e:
            pass

    # 2. DOI publisher download
    if doi:
        try:

            get_pdf_doi(doi, str(filename))

            if filename.exists():
                return {"file_path": str(filename)}

        except Exception as e:
            pass

        # 3. Sci-Hub fallback
        try:
            get_pdf_cell(doi, str(filename))

            if filename.exists():
                return {"file_path": str(filename)}

        except Exception as e:
            print(f" ⚠️ No PMCID or DOI available for PMID {pmid}")
            return {"file_path": None}


# def xml_node_to_text(node) -> str:
#     """
#     Extract readable text from a BeautifulSoup XML node.
#     """
#     if node is None:
#         return ""

#     text = node.get_text(separator=" ", strip=True)
#     text = re.sub(r"\s+", " ", text)

#     return text.strip()


# def split_xml(xml_text: Optional[str]) -> Dict:
#     """
#     Split a PMC/NLM XML article into top-level sections.
#     Only sections with integer labels are used as split points
#     Sections with decimal labels are kept inside their parent section
#     """

#     if not xml_text:
#         return {}

#     soup = BeautifulSoup(xml_text, "xml")

#     body = soup.find("body")
#     if body is None:
#         return {}

#     sections = {}

#     for sec in body.find_all("sec", recursive=False):
#         label_node = sec.find("label", recursive=False)
#         title_node = sec.find("title", recursive=False)

#         if label_node is None:
#             continue

#         label = xml_node_to_text(label_node)

#         if not re.fullmatch(r"\d+", label):
#             continue

#         title = xml_node_to_text(title_node).lower()

#         sec_copy = BeautifulSoup(str(sec), "xml").find("sec")

#         for tag_name in ["label", "title"]:
#             tag = sec_copy.find(tag_name, recursive=False)
#             if tag:
#                 tag.decompose()

#         section_text = xml_node_to_text(sec_copy)

#         sections[title] = section_text

#     return sections


################################################################################


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


# ============================================================================
# PART 3: RELATIONSHIP EXTRACTION
# ============================================================================


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

    # query = build_pubmed_query(all_names, keywords1, keywords2, exceptions)
    # query = query + ' AND (2026/05/08:3000/01/01[pdat])'
    # pmids = search_pubmed(query, limit=limit, email=email)

    # deduplicate PMIDs
    pmids = list(set(pmids1 + pmids2))
    print(f"    ✓ Found {len(pmids)} deduplicated articles on PubMed")

    # Fetch metadata
    articles = fetch_article_data(pmids, email=email, path=path)

    return articles


# ============================================================================ #
# MAIN EXECUTION                                                               #
# ============================================================================ #

from pathlib import Path


def main():
    """
    Complete workflow: Auto-discover → Search → Extract → Export
    """

    path = Path(".")

    output_dir = path / "fulldb"
    output_dir.mkdir(exist_ok=True)
    email = "nikolay.simankov@doct.uliege.be"

    # Your target plants (ONLY Latin names needed!)
    plants = ["Capsicum annuum"]

    for plant in plants:

        output_subdir = output_dir / f"{plant.replace(' ', '_').lower()}"
        output_subdir.mkdir(exist_ok=True)

        result = batch_extract_pubmed(
            plant,
            limit=20000,
            email=email,  # Full coverage
            path=output_subdir,
        )

        # Step 3: Export to JSON
        filename = plant.replace(" ", "_").lower() + "articles.json"
        with open(f"{output_subdir}/articles.json", "w") as f:
            json.dump(result, f, indent=2)

    print("\n" + "=" * 70)
    print("✅ COMPLETE! All databases ready.")
    print("=" * 70)
    print(f"\n📁 Files created:")


if __name__ == "__main__":
    main()
