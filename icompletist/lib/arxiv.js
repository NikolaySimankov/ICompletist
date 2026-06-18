// lib/arxiv.js - Direct arXiv PDF fetcher.
//
// Accepts either a raw arXiv ID (e.g. "2103.00020" or "cs.AI/0102009") or a
// DOI of the form 10.48550/arXiv.X. The PDF URL is deterministic:
//   https://arxiv.org/pdf/{id}        (modern, no .pdf suffix)
//   https://arxiv.org/pdf/{id}.pdf    (legacy, still works as of 2024+)

import { isPdfBlob } from "./pdfcheck.js";

export function arxivIdFromDoi(doi) {
  const m = String(doi).match(/^10\.48550\/arxiv\.(.+)$/i);
  if (!m) return null;
  return m[1].replace(/v\d+$/i, "");
}

export async function arxivFetch(id) {
  if (!id) return { found: false, reason: "No arXiv ID provided" };
  const clean = id.replace(/v\d+$/i, "");

  const urls = [
    `https://arxiv.org/pdf/${clean}`,
    `https://arxiv.org/pdf/${clean}.pdf`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (await isPdfBlob(blob)) {
        return { found: true, blob, arxivId: clean };
      }
    } catch (e) {
      // Try next URL.
    }
  }
  return { found: false, reason: "arXiv PDF fetch failed" };
}
