// lib/identifiers.js - Parse arbitrary text into typed identifiers.
//
// Supports:
//   - DOI:         10.XXXX/...                                (any prefix)
//   - arXiv:       arXiv:2103.00020, arxiv.org/abs/2103.00020
//                  Also matched if found as 10.48550/arXiv.X (then preferred
//                  over the DOI path since direct arXiv is faster).
//   - OpenReview:  openreview.net/forum?id=ABC123, openreview.net/pdf?id=ABC123
//                  Or a bare id of the form ABC123def (8+ chars alphanumeric + _ -)
//                  when prefixed with "openreview:" to disambiguate.

// Publisher "view" suffixes that get appended to a DOI in a URL path but are
// NOT part of the DOI itself: Frontiers /full and /pdf, Wiley /pdf /epdf
// /abstract, etc. Stripped from the end, possibly stacked (/full/pdf).
const DOI_PATH_JUNK_RE =
  /\/(?:pdf|pdfdirect|full|fulltext|abstract|epdf|meta|html|figures?|references|citations|tab-figures|tab-pdf|tab-citations)\/?$/i;

// Canonicalize a DOI string: lower-case, pull out just the DOI token if it's
// embedded in a URL or surrounded by text, and strip artifacts that come from
// copying DOIs out of publisher URLs:
//   - trailing sentence punctuation and slashes
//   - publisher view-suffixes (/pdf, /full, /epdf, …)
//   - preprint version suffixes (bioRxiv/medRxiv/new servers: the dated
//     ID form YYYY.MM.DD.NNNNNN with a trailing vN, plus legacy 10.1101 IDs)
//
// Examples:
//   10.3389/fmolb.2024.1472796/pdf   -> 10.3389/fmolb.2024.1472796
//   10.3389/fhort.2024.1388028/full  -> 10.3389/fhort.2024.1388028
//   10.1101/2025.05.26.656232v1      -> 10.1101/2025.05.26.656232
//   10.64898/2026.04.02.716166v2     -> 10.64898/2026.04.02.716166
export function normalizeDoi(raw) {
  if (!raw) return "";
  let d = String(raw).trim().toLowerCase();
  // Extract just the DOI token if there's surrounding URL/text.
  const m = d.match(/10\.\d{4,9}\/[-._;()/:a-z0-9]+/i);
  if (m) d = m[0];
  d = d.replace(/[.,;]+$/, "").replace(/\/+$/, "");
  // Strip stacked publisher view-suffixes (/full, /pdf, …).
  let prev;
  do {
    prev = d;
    d = d.replace(DOI_PATH_JUNK_RE, "").replace(/\/+$/, "");
  } while (d !== prev);
  // Preprint version suffixes.
  d = d.replace(/(\d{4}\.\d{2}\.\d{2}\.\d+)v\d+$/i, "$1");
  if (/^10\.1101\//i.test(d)) d = d.replace(/v\d+$/i, "");
  return d;
}

// Returns: { type: 'doi'|'arxiv'|'openreview'|'url', value: string, original: string }
export function parseIdentifiers(text) {
  const out = [];
  const seen = new Set();

  function push(type, value, original) {
    const key = `${type}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ type, value, original });
  }

  // Pass 1: arXiv references (handle BEFORE DOIs so arXiv DOIs route to direct fetch).
  // Match arxiv.org URLs, arXiv: prefixed IDs, and 10.48550/arXiv.X DOIs.
  const arxivPatterns = [
    /\barxiv\.org\/(?:abs|pdf)\/([a-z\-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/gi,
    /\barxiv[:\s]+([a-z\-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?\b/gi,
    /\b10\.48550\/arxiv\.([a-z\-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?\b/gi,
  ];
  // Track ranges already consumed so DOI pass doesn't double-match the 10.48550 one.
  const consumed = [];
  for (const re of arxivPatterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      push("arxiv", m[1], m[0]);
      consumed.push([m.index, m.index + m[0].length]);
    }
  }

  // Pass 2: OpenReview references.
  const orPatterns = [
    /\bopenreview\.net\/(?:forum|pdf|attachment)\?id=([A-Za-z0-9_\-]+)/gi,
    /\bopenreview[:\s]+([A-Za-z0-9_\-]{8,})\b/gi,
  ];
  for (const re of orPatterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      push("openreview", m[1], m[0]);
      consumed.push([m.index, m.index + m[0].length]);
    }
  }

  // Pass 3: DOIs, skipping ranges already consumed by arXiv DOI matches.
  const doiRe = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
  let m;
  while ((m = doiRe.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const overlaps = consumed.some(([s, e]) => start < e && end > s);
    if (overlaps) continue;
    const doi = normalizeDoi(m[0]);
    push("doi", doi, m[0]);
    // Record the range so the URL pass below doesn't re-capture the
    // publisher/doi.org URL that contained this DOI.
    consumed.push([start, end]);
  }

  // Pass 4: bare article URLs that did NOT already yield a DOI/arXiv/
  // OpenReview identifier. These need a network round-trip to discover their
  // DOI (handled later by lib/urlresolve.js), so we tag them as type "url".
  // A URL that embedded a recognizable DOI was consumed above and is skipped
  // here — we already have the better identifier.
  const urlRe = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  let u;
  while ((u = urlRe.exec(text)) !== null) {
    const start = u.index;
    const raw = u[0].replace(/[.,;)\]]+$/, "");
    const end = start + raw.length;
    const overlaps = consumed.some(([s, e]) => start < e && end > s);
    if (overlaps) continue;
    push("url", raw, raw);
  }

  return out;
}

// Backwards-compatible: just the DOIs (for callers that need raw DOIs only).
export function parseDois(text) {
  return parseIdentifiers(text).filter((i) => i.type === "doi").map((i) => i.value);
}
