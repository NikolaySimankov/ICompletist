// lib/elsevier.js - Elsevier ScienceDirect TDM API.
// Docs: https://dev.elsevier.com/tecdoc_text_mining.html
//
// You need an API key from https://dev.elsevier.com/ AND your institution must
// be an Elsevier subscriber. The request must originate from your institution's
// IP range OR include your institutional token (X-ELS-Insttoken).
//
// The /content/article/doi/ endpoint returns the full text. Accept header
// controls the format: application/pdf for the PDF.

export async function elsevierTdmFetch(doi, { apiKey, instToken } = {}) {
  if (!apiKey) throw new Error("Elsevier API key not configured.");
  const url = `https://api.elsevier.com/content/article/doi/${encodeURIComponent(doi)}`;
  const headers = {
    "X-ELS-APIKey": apiKey,
    "Accept": "application/pdf",
  };
  if (instToken) headers["X-ELS-Insttoken"] = instToken;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    return { found: false, status: res.status, reason: await res.text().catch(() => "") };
  }
  const blob = await res.blob();
  if (!blob.type.includes("pdf") && blob.size < 5000) {
    // Likely an error message rather than a real PDF.
    return { found: false, status: res.status, reason: "Not a PDF" };
  }
  return { found: true, blob };
}
