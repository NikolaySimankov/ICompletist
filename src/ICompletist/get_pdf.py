"""
PDF – PDF download helpers for PMC, Cell, publisher DOI pages.
"""

import requests
import stealth_requests as scraper
import threading
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


def _download_pdf_url(url: str, filename: str) -> bool:
    """Attempt to download a direct PDF URL. Returns True on success."""
    try:
        response = requests.get(
            url,
            timeout=30,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; research bot; mailto:research@example.com)"
            },
        )
        response.raise_for_status()
        if is_pdf_bytes(response.content):
            with open(filename, "wb") as f:
                f.write(response.content)
            return True
    except Exception:
        pass
    return False


def _oa_pdf_urls_unpaywall(doi: str, email: str) -> list:
    """Return all PDF URLs found by Unpaywall, best location first."""
    try:
        data = requests.get(
            f"https://api.unpaywall.org/v2/{doi}",
            params={"email": email},
            timeout=15,
        ).json()
        urls = []
        best = data.get("best_oa_location") or {}
        if best.get("url_for_pdf"):
            urls.append(best["url_for_pdf"])
        for loc in data.get("oa_locations", []):
            u = loc.get("url_for_pdf")
            if u and u not in urls:
                urls.append(u)
        return urls
    except Exception:
        return []


def _oa_pdf_urls_semantic_scholar(doi: str) -> list:
    """Return PDF URL from Semantic Scholar open-access data."""
    try:
        data = requests.get(
            f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}",
            params={"fields": "openAccessPdf"},
            timeout=15,
        ).json()
        url = (data.get("openAccessPdf") or {}).get("url")
        return [url] if url else []
    except Exception:
        return []


def _oa_pdf_urls_openalex(doi: str) -> list:
    """Return PDF URLs from OpenAlex OA locations."""
    try:
        data = requests.get(
            f"https://api.openalex.org/works/doi:{doi}",
            timeout=15,
        ).json()
        urls = []
        best = (data.get("best_oa_location") or {}).get("pdf_url")
        if best:
            urls.append(best)
        for loc in data.get("locations", []):
            u = loc.get("pdf_url")
            if u and u not in urls:
                urls.append(u)
        return urls
    except Exception:
        return []


def get_pdf_oa(
    doi: str,
    filename: str,
    email: str = "research@example.com",
) -> bool:
    """Try to download an open-access PDF by querying Unpaywall, Semantic Scholar,
    and OpenAlex in order, attempting every PDF URL found until one succeeds.
    Returns True if a PDF was saved.
    """
    candidates: list = []
    for source_fn in (
        lambda: _oa_pdf_urls_unpaywall(doi, email),
        lambda: _oa_pdf_urls_semantic_scholar(doi),
        lambda: _oa_pdf_urls_openalex(doi),
    ):
        for url in source_fn():
            if url not in candidates:
                candidates.append(url)

    for url in candidates:
        if _download_pdf_url(url, filename):
            return True
    return False


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

    # mdpi
    if domain == "www.mdpi.com":
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
    email: str = "research@example.com",
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

        # 3. OA repositories fallback (Unpaywall + Semantic Scholar + OpenAlex)
        if get_pdf_oa(doi, str(filename), email=email):
            if filename.exists():
                return {"file_path": str(filename)}

    print(f" ⚠️ Could not download PDF for PMID {pmid}")
    return {"file_path": None}


def get_pdf_playwright_stealth(url: str, filename: str) -> bool:
    """
    Two-phase PDF download:
      Phase 1 — Playwright (+ playwright-stealth) runs in a separate thread to
                avoid conflicts with Jupyter's asyncio loop. It solves JS bot
                challenges (Akamai PoW, Cloudflare turnstile), intercepts PDF
                bytes from the network, and harvests session cookies.
      Phase 2 — stealth_requests reuses those cookies with a spoofed TLS
                fingerprint for a lightweight binary download.
    Returns True if a PDF was saved to *filename*.
    """
    from playwright.sync_api import sync_playwright
    from playwright_stealth import Stealth

    captured_pdf: list = []
    state = {"resolved_url": url, "cookies": {}}

    def _run():
        def _on_response(response):
            ct = response.headers.get("content-type", "")
            if "pdf" in ct or "octet-stream" in ct:
                try:
                    body = response.body()
                    if is_pdf_bytes(body):
                        captured_pdf.append(body)
                except Exception:
                    pass

        with Stealth().use_sync(sync_playwright()) as pw:
            browser = pw.chromium.launch(headless=True)
            context = browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                )
            )
            page = context.new_page()
            page.on("response", _on_response)

            page.goto(url, wait_until="networkidle", timeout=30_000)
            page.wait_for_timeout(2_000)

            if not captured_pdf:
                pdf_meta = page.query_selector('meta[name="citation_pdf_url"]')
                if pdf_meta:
                    pdf_url = pdf_meta.get_attribute("content")
                    page.goto(pdf_url, wait_until="networkidle", timeout=30_000)
                    page.wait_for_timeout(2_000)

            state["resolved_url"] = page.url
            state["cookies"] = {c["name"]: c["value"] for c in context.cookies()}
            browser.close()

    t = threading.Thread(target=_run)
    t.start()
    t.join()

    if captured_pdf:
        with open(filename, "wb") as f:
            f.write(captured_pdf[0])
        return True

    try:
        resp = scraper.get(
            state["resolved_url"],
            cookies=state["cookies"],
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/124.0.0.0 Safari/537.36"
                ),
                "Referer": state["resolved_url"],
                "Accept": "application/pdf,*/*",
            },
            timeout=30,
        )
        if is_pdf_bytes(resp.content):
            with open(filename, "wb") as f:
                f.write(resp.content)
            return True
    except Exception:
        pass

    return False
