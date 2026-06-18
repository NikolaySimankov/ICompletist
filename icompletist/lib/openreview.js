// lib/openreview.js - OpenReview PDF fetcher.
//
// OpenReview hosts open peer review for NeurIPS, ICLR, ICML, COLM, COLT, and
// many other ML conferences. Papers are identified by short forum IDs.
//
// The PDF endpoint is direct and stable:
//   https://openreview.net/pdf?id={id}
//
// We don't need the API for fetching, but we use it for metadata when
// available. The API does not require auth for public papers.
//
// Docs: https://docs.openreview.net/getting-started/using-the-api/notes

import { isPdfBlob } from "./pdfcheck.js";

export async function openreviewFetch(id) {
  if (!id) return { found: false, reason: "No OpenReview ID provided" };

  const pdfUrl = `https://openreview.net/pdf?id=${encodeURIComponent(id)}`;
  const res = await fetch(pdfUrl, { redirect: "follow" });

  if (!res.ok) {
    return { found: false, status: res.status, reason: `OpenReview returned ${res.status}` };
  }

  const blob = await res.blob();
  if (await isPdfBlob(blob)) {
    return { found: true, blob, id };
  }
  return { found: false, reason: "Response was not a PDF (paper may be withdrawn or private)" };
}
