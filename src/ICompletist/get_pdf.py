"""
PDF – PDF download helpers for PMC, Cell, publisher DOI pages.
"""

import stealth_requests as scraper
from urllib.parse import urlparse

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from pathlib import Path

from typing import Optional
from bs4 import BeautifulSoup


def is_pdf_bytes(content: bytes) -> bool:
    return content[:4] == b"%PDF"


def get_pdf_pmc(
    pmcid: str,
    filename: str,
) -> None:
    """
    Download the PDF file for a given PMCID from the PMC Open Access Subset.
    """

    def get_available_versions(s3_client, pmcid):
        """
        Récupère les versions disponibles d'un article PMC
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


def get_pdf_scihub(
    doi: str,
    filename: str,
) -> None:
    """
    Download the PDF file for a given DOI from Sci-Hub.
    """

    base_url = "https://sci-hub.fr"

    # Build full URL if it's a relative path
    html_url = base_url + "/" + doi
    response = scraper.get(html_url)

    # Step 1 — Parse the HTML
    soup = BeautifulSoup(response.content, "html.parser")

    # Step 2 — Find the download link
    href = soup.select_one("div.download a")["href"]

    pdf_url = base_url + href
    response = scraper.get(pdf_url)
    # Now use the extracted URL
    if is_pdf_bytes(response.content):
        with open(filename, "wb") as f:
            f.write(response.content)


def get_pdf_doi(
    doi: str,
    filename: str,
) -> None:
    """
    Download the PDF file for a given DOI from Cell.
    """
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    }

    doi_url = f"https://doi.org/{doi}"
    response = scraper.get(
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
        response = scraper.get(pdf_url, headers=headers)
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

        response = scraper.get(epdf_url, headers)
        soup = BeautifulSoup(response.content, "html.parser")

        href = soup.find("a", {"class": "btn--bordered__light"})["href"]

        # Build full URL from a relative path
        pdf_url = "https://" + domain + href

        # Now use the extracted URL
        response = scraper.get(pdf_url, headers=headers)
        if is_pdf_bytes(response.content):
            with open(filename, "wb") as f:
                f.write(response.content)
        else:
            return pdf_url


def get_pdf_institution(
    pmcid: str,
    doi: str,
    pmid: Optional[str] = None,
    path: Optional[str] = ".",
) -> None:
    """
    Download a PDF file from a given URL.
    Try PMC first, then fallback to Cell if DOI is available.
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


def get_pdf(
    pmcid: str,
    doi: str,
    pmid: Optional[str] = None,
    path: Optional[str] = ".",
) -> None:
    """
    Download a PDF file from a given URL.
    Try PMC first, then fallback to Cell if DOI is available.
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
            get_pdf_scihub(doi, str(filename))

            if filename.exists():
                return {"file_path": str(filename)}

        except Exception as e:
            print(f" ⚠️ No PMCID or DOI available for PMID {pmid}")
            return {"file_path": None}
