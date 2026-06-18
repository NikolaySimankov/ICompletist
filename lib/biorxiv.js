// lib/biorxiv.js - bioRxiv and medRxiv preprint fetcher.
//
// DOI prefix: 10.1101/. bioRxiv and medRxiv share API infrastructure.
// API: https://api.biorxiv.org/details/{server}/{doi}/na/json
// Docs: https://api.biorxiv.org/
//
// The API response includes link_pdf (full PDF URL) and link_page (article
// landing page URL). We use these directly rather than guessing the URL
// pattern, which is more reliable and avoids version-number guessing.
//
// All bioRxiv content is OA; the servers don't require auth but their CDN can
// rate-limit or block requests that look automated. Sending browser-typical
// headers (Accept, Accept-Language, Referer) reduces 403 responses from
// bot-detection layers.

import { isPdfBlob } from "./pdfcheck.js";

export function isBiorxivDoi(doi) {
  return /^10\.1101\//i.test(doi);
}

// Browser-mimic headers to reduce CDN bot-detection 403s.
function browserHeaders(refererUrl) {
  return {
    "Accept": "application/pdf,application/x-pdf,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...(refererUrl ? { "Referer": refererUrl } : {}),
  };
}

async function queryApi(doi, server) {
  // Raw DOI in path — do NOT urlencode the slash, the API expects a literal /.
  const url = `https://api.biorxiv.org/details/${server}/${doi}/na/json`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.info(`bioRxiv API: ${server} returned ${res.status} for ${doi}`);
      return null;
    }
    const data = await res.json();
    const records = data.collection;
    if (!records || !records.length) {
      console.info(`bioRxiv API: ${server} has no records for ${doi}`);
      return null;
    }
    // Use the latest version (records are ordered by version ascending).
    return { ...records[records.length - 1], server };
  } catch (e) {
    console.warn(`bioRxiv API error for ${server}/${doi}:`, e);
    return null;
  }
}

async function tryPdfUrl(url, refererUrl, attempts, label) {
  console.info(`bioRxiv: fetching ${url}`);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: browserHeaders(refererUrl),
    });
    if (!res.ok) {
      attempts.push(`${label} → ${res.status}`);
      return null;
    }
    const blob = await res.blob();
    if (await isPdfBlob(blob)) return blob;
    attempts.push(`${label} → not PDF (type=${blob.type}, size=${blob.size})`);
    return null;
  } catch (e) {
    attempts.push(`${label} → error: ${e.message}`);
    return null;
  }
}

export async function biorxivFetch(doi) {
  if (!isBiorxivDoi(doi)) return { found: false, reason: "Not a bioRxiv/medRxiv DOI" };

  // Look up on both servers — most preprints are on bioRxiv, but the API
  // distinguishes biorxiv from medrxiv and 404s the wrong one.
  let record = await queryApi(doi, "biorxiv");
  if (!record) record = await queryApi(doi, "medrxiv");
  if (!record) return { found: false, reason: "Not in bioRxiv or medRxiv" };

  const host = record.server === "medrxiv" ? "www.medrxiv.org" : "www.biorxiv.org";
  const version = parseInt(record.version, 10) || 1;
  const articlePage = record.link_page || `https://${host}/content/${doi}v${version}`;

  const attempts = [];

  // Strategy 1: link_pdf from the API response. This is the authoritative URL.
  if (record.link_pdf) {
    const blob = await tryPdfUrl(record.link_pdf, articlePage, attempts, "link_pdf");
    if (blob) {
      return { found: true, blob, server: record.server, version, title: record.title, via: "link_pdf" };
    }
  }

  // Strategy 2: constructed URL using the API-reported version. Sometimes
  // link_pdf is missing or stale even though the canonical URL works.
  const canonicalPdf = `https://${host}/content/${doi}v${version}.full.pdf`;
  if (canonicalPdf !== record.link_pdf) {
    const blob = await tryPdfUrl(canonicalPdf, articlePage, attempts, `v${version}.full.pdf`);
    if (blob) {
      return { found: true, blob, server: record.server, version, title: record.title, via: "canonical" };
    }
  }

  // Strategy 3: full path (no .pdf suffix). bioRxiv redirects this to the PDF
  // for OA preprints — sometimes the redirect avoids whatever's blocking the
  // direct .pdf URL.
  const fullPath = `https://${host}/content/${doi}v${version}.full`;
  const blob = await tryPdfUrl(fullPath, articlePage, attempts, `v${version}.full`);
  if (blob) {
    return { found: true, blob, server: record.server, version, title: record.title, via: "full" };
  }

  return { found: false, reason: `bioRxiv attempts: ${attempts.join("; ")}` };
}
