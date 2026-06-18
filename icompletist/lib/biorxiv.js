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

import { isPdfBlob } from "./pdfcheck.js";

export function isBiorxivDoi(doi) {
  return /^10\.1101\//i.test(doi);
}

async function tryServer(doi, server) {
  const url = `https://api.biorxiv.org/details/${server}/${encodeURIComponent(doi)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.info(`bioRxiv API: ${server} returned ${res.status} for ${doi}`);
      return null;
    }
    const data = await res.json();
    if (!data.collection || !data.collection.length) {
      console.info(`bioRxiv API: ${server} has no collection for ${doi}`);
      return null;
    }
    const latest = data.collection[data.collection.length - 1];
    return { ...latest, server };
  } catch (e) {
    console.warn(`bioRxiv API error for ${server}/${doi}:`, e);
    return null;
  }
}

export async function biorxivFetch(doi) {
  if (!isBiorxivDoi(doi)) return { found: false, reason: "Not a bioRxiv/medRxiv DOI" };

  let record = await tryServer(doi, "biorxiv");
  if (!record) record = await tryServer(doi, "medrxiv");
  if (!record) return { found: false, reason: "Not in bioRxiv or medRxiv" };

  const host = record.server === "medrxiv" ? "www.medrxiv.org" : "www.biorxiv.org";
  const version = record.version || 1;
  const pdfUrl = `https://${host}/content/${doi}v${version}.full.pdf`;
  console.info(`bioRxiv: fetching ${pdfUrl}`);

  try {
    const pdfRes = await fetch(pdfUrl, { redirect: "follow" });
    if (!pdfRes.ok) {
      return { found: false, status: pdfRes.status, reason: `PDF fetch returned ${pdfRes.status}` };
    }
    const blob = await pdfRes.blob();
    if (await isPdfBlob(blob)) {
      return { found: true, blob, server: record.server, version, title: record.title };
    }
    return { found: false, reason: `Response was not a PDF (type=${blob.type}, size=${blob.size})` };
  } catch (e) {
    return { found: false, reason: `PDF fetch error: ${e.message}` };
  }
}
