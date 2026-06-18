// lib/urlresolve.js - Resolve an article URL to its DOI.
//
// Users can paste publisher / repository / landing-page URLs instead of bare
// identifiers. To make those behave exactly like a DOI (same fetch cascade,
// same RIS output), we first discover the DOI for the page:
//
//   1. The DOI may already be in the URL path (doi.org/10.x, publisher
//      /doi/10.x links, etc.) — no network needed.
//   2. Otherwise fetch the HTML and read the standard bibliographic meta
//      tags every major publisher emits for Google Scholar / Zotero:
//        <meta name="citation_doi" content="10.x">
//        <meta name="dc.identifier" content="doi:10.x">
//        <meta name="prism.doi" content="10.x">
//      (attribute order varies, so we scan each <meta> tag generically.)
//   3. Fall back to the post-redirect URL, then any DOI-looking string in
//      the page body (covers JSON-LD blocks and inline references).
//
// NOTE: service workers have no DOMParser, so meta-tag extraction is done
// with regex over the raw HTML rather than a parsed DOM.

const DOI_RE = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i;

// Meta tag names (lower-cased) that carry a DOI, in rough priority order.
const DOI_META_NAMES = new Set([
  "citation_doi",
  "bepress_citation_doi",
  "dc.identifier",
  "dc.identifier.doi",
  "prism.doi",
  "doi",
]);

function cleanDoi(s) {
  if (!s) return null;
  const m = String(s).match(DOI_RE);
  if (!m) return null;
  return m[0].replace(/[.,;]+$/, "").toLowerCase();
}

function extractDoiFromHtml(html) {
  if (!html) return null;
  // Scan every <meta ...> tag; pull name/property + content regardless of
  // attribute order.
  const metaRe = /<meta\b[^>]*>/gi;
  let tag;
  while ((tag = metaRe.exec(html)) !== null) {
    const t = tag[0];
    const nameMatch = t.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    if (!nameMatch) continue;
    if (!DOI_META_NAMES.has(nameMatch[1].toLowerCase())) continue;
    const contentMatch = t.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    const doi = cleanDoi(contentMatch ? contentMatch[1] : "");
    if (doi) return doi;
  }
  // Last resort: any DOI-looking token anywhere in the document.
  return cleanDoi(html);
}

// Resolve a single URL to a DOI string, or null if none can be found.
export async function doiFromUrl(url, { email } = {}) {
  // 1. DOI already present in the given URL.
  const inUrl = cleanDoi(url);
  if (inUrl) return inUrl;

  // 2. Fetch the page and inspect meta tags + final URL + body.
  let res;
  try {
    res = await fetch(url, {
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        ...(email ? { "From": email } : {}),
      },
    });
  } catch (e) {
    console.warn(`doiFromUrl: network error for ${url}:`, e);
    return null;
  }
  if (!res.ok) {
    console.info(`doiFromUrl: ${url} returned ${res.status}`);
    // The redirect chain might still have landed on a DOI-bearing URL.
    return cleanDoi(res.url);
  }

  let html = "";
  try { html = await res.text(); } catch { /* ignore */ }

  return extractDoiFromHtml(html) || cleanDoi(res.url);
}
