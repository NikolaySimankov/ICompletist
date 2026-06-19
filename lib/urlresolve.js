// lib/urlresolve.js - Resolve an article URL to its DOI.
//
// Users can paste publisher / repository / landing-page URLs instead of bare
// identifiers. To make those behave exactly like a DOI (same fetch cascade,
// same RIS output), we discover the DOI for the page in this order:
//
//   1. DOI already present in the URL path (doi.org/10.x, Frontiers
//      /articles/10.x/full, Wiley /doi/10.x, …). normalizeDoi() strips the
//      /full, /pdf and vN artifacts those URLs carry.
//   2. Biomedical ID-bearing hosts resolved via authoritative APIs instead
//      of scraping, because the DOI is NOT in the URL:
//        - PMC      (pmc.ncbi.nlm.nih.gov/articles/PMC123, europepmc /PMC123)
//                   → NCBI idconv  (PMCID → DOI)
//        - PubMed   (pubmed.ncbi.nlm.nih.gov/12345)
//                   → NCBI idconv  (PMID → DOI)
//        - ScienceDirect (/science/article/pii/Sxxxx)
//                   → Elsevier article API (PII → DOI), when a key is set
//   3. Generic fallback: fetch the HTML and read the standard bibliographic
//      meta tags (citation_doi, dc.identifier, prism.doi), then the
//      post-redirect URL, then any DOI in the body.
//
// NOTE: service workers have no DOMParser, so meta-tag extraction is regex
// over the raw HTML.

import { normalizeDoi } from "./identifiers.js";

const DOI_RE = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i;

const DOI_META_NAMES = new Set([
  "citation_doi",
  "bepress_citation_doi",
  "dc.identifier",
  "dc.identifier.doi",
  "prism.doi",
  "doi",
]);

function cleanDoi(s) {
  if (!s || !DOI_RE.test(String(s))) return null;
  const d = normalizeDoi(s);
  return d || null;
}

// Scan the page body for the article DOI when meta tags are missing.
// Strategy, strongest signal first:
//   1. doi.org / dx.doi.org links (e.g. MDPI's <a href="https://doi.org/10.x">).
//      The article's own DOI usually appears several times on the page (header,
//      cite box, JSON-LD) while each reference DOI appears once — so we pick the
//      MOST FREQUENT doi.org link, tie-broken by first appearance.
//   2. JSON / data attributes like "doi":"10.x" or data-doi="10.x".
//   3. Last resort: the first DOI-looking token anywhere (least reliable).
function doiFromBody(html) {
  const linkRe = /https?:\/\/(?:dx\.)?doi\.org\/(10\.\d{4,9}\/[^\s"'<>)]+)/gi;
  const counts = new Map();
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const d = normalizeDoi(m[1]);
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  }
  if (counts.size) {
    let best = null;
    let bestN = 0;
    for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; } // Map keeps insertion order → first wins ties
    return best;
  }

  const jsonRe = /["']?(?:doi|DOI)["']?\s*[:=]\s*["'](10\.\d{4,9}\/[^\s"'<>]+)["']/i;
  const jm = html.match(jsonRe);
  if (jm) {
    const d = normalizeDoi(jm[1]);
    if (d) return d;
  }

  return cleanDoi(html);
}

function extractDoiFromHtml(html) {
  if (!html) return null;
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
  // No usable meta tag — fall back to scanning the body.
  return doiFromBody(html);
}

// PMID/PMCID → DOI via NCBI's ID converter. Works for both id types.
async function idconvToDoi(id, email) {
  const params = new URLSearchParams({ ids: id, format: "json", tool: "icompletist" });
  if (email) params.set("email", email);
  let res;
  try {
    res = await fetch(`https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?${params}`);
  } catch (e) {
    console.warn(`idconv network error for ${id}:`, e);
    return null;
  }
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch { return null; }
  const rec = data.records?.[0];
  if (!rec || rec.status === "error") return null;
  return rec.doi ? cleanDoi(rec.doi) : null;
}

// ScienceDirect PII → DOI via the Elsevier article API (requires a key).
async function piiToDoi(pii, settings) {
  if (!settings?.elsevierKey) return null;
  const headers = {
    "X-ELS-APIKey": settings.elsevierKey,
    "Accept": "application/json",
  };
  if (settings.elsevierInstToken) headers["X-ELS-Insttoken"] = settings.elsevierInstToken;
  let res;
  try {
    res = await fetch(`https://api.elsevier.com/content/article/pii/${encodeURIComponent(pii)}`, { headers });
  } catch (e) {
    console.warn(`Elsevier PII lookup network error for ${pii}:`, e);
    return null;
  }
  if (!res.ok) return null;
  let data;
  try { data = await res.json(); } catch { return null; }
  const doi = data?.["full-text-retrieval-response"]?.coredata?.["prism:doi"];
  return doi ? cleanDoi(doi) : null;
}

// Resolve a single URL to a DOI string, or null if none can be found.
// `settings` carries email (NCBI etiquette) and the Elsevier key (PII lookup).
export async function doiFromUrl(url, settings = {}) {
  const email = settings.email;

  // 1. DOI already in the URL path.
  const inUrl = cleanDoi(url);
  if (inUrl) return inUrl;

  // 2. ID-bearing hosts — resolve via the right API rather than scraping.
  const pmc = url.match(/\bPMC(\d+)\b/i);
  if (pmc) {
    const doi = await idconvToDoi(`PMC${pmc[1]}`, email);
    if (doi) return doi;
  }
  const pubmed = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
  if (pubmed) {
    const doi = await idconvToDoi(pubmed[1], email);
    if (doi) return doi;
  }
  const pii = url.match(/\/(?:pii|article)\/(S[0-9X]+)\b/i);
  if (pii) {
    const doi = await piiToDoi(pii[1], settings);
    if (doi) return doi;
  }

  // 3. Generic: fetch the page and read meta tags / final URL / body.
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
    return cleanDoi(res.url);
  }

  let html = "";
  try { html = await res.text(); } catch { /* ignore */ }

  return extractDoiFromHtml(html) || cleanDoi(res.url);
}
