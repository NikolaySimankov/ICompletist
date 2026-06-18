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

// Returns: { type: 'doi'|'arxiv'|'openreview', value: string, original: string }
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
    const doi = m[0].toLowerCase().replace(/[.,;]+$/, "");
    push("doi", doi, m[0]);
  }

  return out;
}

// Backwards-compatible: just the DOIs (for callers that need raw DOIs only).
export function parseDois(text) {
  return parseIdentifiers(text).filter((i) => i.type === "doi").map((i) => i.value);
}
