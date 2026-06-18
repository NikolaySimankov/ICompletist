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
  // The bioRxiv API expects the raw DOI in the URL path, including the literal
  // slash between prefix and suffix. URL-encoding the slash to %2F yields a
  // 404 silently.
  const url = `https://api.biorxiv.org/details/${server}/${doi}/na/json`;
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
  // Try the version the API reports first, then fall back to v1/v2/v3 in case
  // the response lacks a version field or is stale.
  const declaredVersion = parseInt(record.version, 10);
  const versionsToTry = [];
  if (!isNaN(declaredVersion)) versionsToTry.push(declaredVersion);
  for (const v of [1, 2, 3, 4]) if (!versionsToTry.includes(v)) versionsToTry.push(v);

  let lastError = null;
  for (const v of versionsToTry) {
    const pdfUrl = `https://${host}/content/${doi}v${v}.full.pdf`;
    console.info(`bioRxiv: fetching ${pdfUrl}`);
    try {
      const pdfRes = await fetch(pdfUrl, { redirect: "follow" });
      if (!pdfRes.ok) {
        lastError = `v${v} returned ${pdfRes.status}`;
        continue;
      }
      const blob = await pdfRes.blob();
      if (await isPdfBlob(blob)) {
        return { found: true, blob, server: record.server, version: v, title: record.title };
      }
      lastError = `v${v} response was not a PDF (type=${blob.type}, size=${blob.size})`;
    } catch (e) {
      lastError = `v${v} fetch error: ${e.message}`;
    }
  }
  return { found: false, reason: lastError || "All version attempts failed" };
}
