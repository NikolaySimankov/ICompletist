// lib/core.js - CORE.ac.uk OA paper lookup.
//
// COMPLIANCE: CORE's terms forbid bypassing the API by constructing
// files.core.ac.uk/download/{id}.pdf URLs directly. This module ONLY uses
// URLs the API itself returns. We do prefer the CORE-hosted PDF (which the
// API exposes via the `links` array as type=download) over upstream URLs
// because those are CORE's own redistribution endpoints — that's the
// compliant way to fetch a PDF from CORE.
//
// API: https://api.core.ac.uk/v3/
// Auth: Bearer token in Authorization header (ONLY on api.core.ac.uk calls;
// never on cross-origin PDF fetches, which would trigger CORS preflights
// that fail on third-party redirects).
//
// Get a key: https://core.ac.uk/services/api

import { isPdfBlob, describeBlob } from "./pdfcheck.js";

const ENDPOINT = "https://api.core.ac.uk/v3/search/works";

// Pick the best PDF URL from a CORE work record. Preference order:
//   1. links[type=download]      — CORE's own CDN, most reliable
//   2. fullTextIdentifier       — when it ends in .pdf
//   3. downloadUrl              — fallback, often a publisher/repo URL
//                                 (can be HTML or a DOI resolver — we filter
//                                 obvious non-PDFs)
function pickPdfUrl(work) {
  // Prefer CORE-hosted download links.
  const links = Array.isArray(work.links) ? work.links : [];
  const coreDownload = links.find((l) => l && l.type === "download" && typeof l.url === "string");
  if (coreDownload && /^https:\/\/(api|core)\.core\.ac\.uk\//i.test(coreDownload.url)) {
    return { url: coreDownload.url, source: "core-cdn" };
  }
  if (coreDownload) {
    return { url: coreDownload.url, source: "core-link" };
  }

  // Try fullTextIdentifier if it looks like a PDF.
  if (typeof work.fullTextIdentifier === "string" && /\.pdf(\?|$)/i.test(work.fullTextIdentifier)) {
    return { url: work.fullTextIdentifier, source: "core-fulltext" };
  }

  // Last resort: downloadUrl. Reject obvious non-PDF targets.
  if (typeof work.downloadUrl === "string") {
    const u = work.downloadUrl;
    // Skip DOI resolver redirects — they can't be fetched cross-origin
    // without triggering preflight/redirect issues, and they're usually
    // landing pages, not PDFs.
    if (/^https?:\/\/(dx\.)?doi\.org\//i.test(u)) {
      return null;
    }
    return { url: u, source: "core-downloadurl" };
  }

  return null;
}

export async function coreLookup(doi, { apiKey } = {}) {
  if (!apiKey) return { found: false, reason: "CORE API key not configured" };

  const url = `${ENDPOINT}?q=doi:%22${encodeURIComponent(doi)}%22&limit=1`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    return { found: false, reason: `CORE lookup network error: ${e.message}` };
  }
  if (!res.ok) {
    return { found: false, status: res.status, reason: `CORE lookup returned ${res.status}` };
  }

  let data;
  try { data = await res.json(); } catch { return { found: false, reason: "Bad JSON from CORE" }; }

  const work = data.results?.[0];
  if (!work) return { found: false, reason: "Not in CORE" };

  const pick = pickPdfUrl(work);
  if (!pick) return { found: false, reason: "CORE record has no usable PDF URL" };

  // PDF fetch: NO Authorization header. CORE's own CDN doesn't require it,
  // and adding it on any cross-origin URL forces a CORS preflight that
  // typically fails when there's a redirect (e.g. dx.doi.org -> publisher).
  let pdfRes;
  try {
    pdfRes = await fetch(pick.url, { redirect: "follow" });
  } catch (e) {
    return { found: false, reason: `CORE PDF fetch network error (${pick.source}): ${e.message}` };
  }
  if (!pdfRes.ok) {
    return { found: false, status: pdfRes.status, reason: `${pick.source} returned ${pdfRes.status}` };
  }

  const blob = await pdfRes.blob();
  if (await isPdfBlob(blob)) {
    return { found: true, blob, title: work.title, via: pick.source };
  }
  return { found: false, reason: `CORE response was not a PDF (${pick.source}, ${await describeBlob(blob)})` };
}
