// lib/biorxiv.js - bioRxiv and medRxiv preprint fetcher.
//
// Both servers use DOI prefix 10.1101/. bioRxiv and medRxiv share infrastructure;
// the API distinguishes them via the {server} path parameter.
//
// API: https://api.biorxiv.org/details/{server}/{doi}
// Docs: https://api.biorxiv.org/
//
// Each version of a preprint is returned as a separate record. We take the
// latest version. The PDF URL pattern is:
//   https://www.biorxiv.org/content/{doi}v{version}.full.pdf
//   https://www.medrxiv.org/content/{doi}v{version}.full.pdf
//
// No auth, no rate limit issues for normal use. Both servers are fully OA.

export function isBiorxivDoi(doi) {
  return /^10\.1101\//i.test(doi);
}

async function tryServer(doi, server) {
  const url = `https://api.biorxiv.org/details/${server}/${encodeURIComponent(doi)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.collection || !data.collection.length) return null;
  // Latest version is last.
  const latest = data.collection[data.collection.length - 1];
  return { ...latest, server };
}

export async function biorxivFetch(doi) {
  if (!isBiorxivDoi(doi)) return { found: false, reason: "Not a bioRxiv/medRxiv DOI" };

  // Try bioRxiv first, fall back to medRxiv if not found there.
  let record = await tryServer(doi, "biorxiv");
  if (!record) record = await tryServer(doi, "medrxiv");
  if (!record) return { found: false, reason: "Not in bioRxiv or medRxiv" };

  const host = record.server === "medrxiv" ? "www.medrxiv.org" : "www.biorxiv.org";
  const version = record.version || 1;
  const pdfUrl = `https://${host}/content/${doi}v${version}.full.pdf`;

  const pdfRes = await fetch(pdfUrl, { redirect: "follow" });
  if (!pdfRes.ok) return { found: false, status: pdfRes.status, reason: "PDF fetch failed" };

  const blob = await pdfRes.blob();
  if (blob.type.includes("pdf") || blob.size > 10000) {
    return { found: true, blob, server: record.server, version, title: record.title };
  }
  return { found: false, reason: "Response was not a PDF" };
}
