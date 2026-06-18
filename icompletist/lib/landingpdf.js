// lib/landingpdf.js - Extract a PDF URL from an article landing page.
//
// Many fully-OA publishers (Frontiers, MDPI, PLOS, Hindawi, Copernicus, eLife,
// PeerJ, …) advertise the direct PDF on the article page via the Google
// Scholar / Zotero standard meta tag:
//   <meta name="citation_pdf_url" content="https://…/article.pdf">
// This is the generalized form of the per-publisher scraping in the Python
// get_pdf.py (which special-cased Springer/MDPI/APS). When the OA aggregators
// miss an item, scraping this tag from the landing page rescues a good share.
//
// Service workers have no DOMParser, so we regex over the raw HTML. Relative
// content URLs are resolved against the post-redirect URL.

const PDF_META_NAMES = new Set(["citation_pdf_url", "bepress_citation_pdf_url"]);

function absolutize(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

// Fetch a landing page and return the absolute citation_pdf_url URL(s) it
// declares (empty array if none / on error).
export async function citationPdfUrls(landingUrl, { email } = {}) {
  let res;
  try {
    res = await fetch(landingUrl, {
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...(email ? { "From": email } : {}),
      },
    });
  } catch (e) {
    console.warn(`citationPdfUrls: network error for ${landingUrl}:`, e);
    return [];
  }
  if (!res.ok) return [];

  let html = "";
  try { html = await res.text(); } catch { return []; }
  const base = res.url || landingUrl;

  const out = [];
  const seen = new Set();
  const metaRe = /<meta\b[^>]*>/gi;
  let tag;
  while ((tag = metaRe.exec(html)) !== null) {
    const t = tag[0];
    const nameMatch = t.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    if (!nameMatch || !PDF_META_NAMES.has(nameMatch[1].toLowerCase())) continue;
    const contentMatch = t.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    const abs = contentMatch ? absolutize(contentMatch[1], base) : null;
    if (abs && !seen.has(abs)) { seen.add(abs); out.push(abs); }
  }
  return out;
}
