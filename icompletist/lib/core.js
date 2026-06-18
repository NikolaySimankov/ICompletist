// lib/core.js - CORE.ac.uk OA paper lookup.
//
// COMPLIANCE: CORE's terms explicitly forbid bypassing the API by constructing
// files.core.ac.uk/download/{id}.pdf URLs directly. We ONLY use the URLs the
// API itself returns in its response, which point to CORE's CDN and are signed
// for the requesting key. This module never constructs files.core.ac.uk URLs.
//
// API: https://api.core.ac.uk/v3/
// Auth: Bearer token in Authorization header
// Get a key: https://core.ac.uk/services/api (free, requires registration)
//
// We use the /search/works endpoint to look up by DOI. The downloadUrl field
// in the response is the only PDF URL we'll ever fetch from CORE.

const ENDPOINT = "https://api.core.ac.uk/v3/search/works";

export async function coreLookup(doi, { apiKey } = {}) {
  if (!apiKey) return { found: false, reason: "CORE API key not configured" };

  const url = `${ENDPOINT}?q=doi:%22${encodeURIComponent(doi)}%22&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    return { found: false, status: res.status, reason: `CORE returned ${res.status}` };
  }

  let data;
  try { data = await res.json(); } catch { return { found: false, reason: "Bad JSON from CORE" }; }

  const work = data.results?.[0];
  if (!work) return { found: false, reason: "Not in CORE" };

  // The downloadUrl field is the API-provided PDF URL. We ONLY use this — never
  // construct files.core.ac.uk URLs ourselves.
  const pdfUrl = work.downloadUrl;
  if (!pdfUrl) return { found: false, reason: "CORE record has no OA PDF" };

  const pdfRes = await fetch(pdfUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: "follow",
  });
  if (!pdfRes.ok) return { found: false, status: pdfRes.status };

  const blob = await pdfRes.blob();
  if (blob.type.includes("pdf") || blob.size > 10000) {
    return { found: true, blob, title: work.title };
  }
  return { found: false, reason: "CORE response was not a PDF" };
}
