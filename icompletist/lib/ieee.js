// lib/ieee.js - IEEE Xplore PDF fetcher for Open Access content.
//
// IEEE DOI prefix: 10.1109/
//
// IEEE Xplore offers two APIs:
//   1. Metadata API (free key): returns article metadata + sometimes PDF URL
//      for OA content. https://developer.ieee.org/
//   2. Open Access API: same key, scoped to OA articles only.
//
// The PDF "stamp" URL (https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=N)
// requires an active institutional session for non-OA content, so we don't
// attempt it here — the institutional resolver step handles that path.
//
// For OA articles, we:
//   1. Query the metadata API with the DOI to get the article number and OA flag
//   2. If OA, construct the document PDF URL: ieeexplore.ieee.org/ielx7/.../paper.pdf
//      In practice IEEE's "open_access_flag" responses include a `pdf_url` field.
//
// Get an API key: https://developer.ieee.org/getting_started (free, requires
// IEEE account; no institutional contract needed for the basic OA-aware API).

export function isIeeeDoi(doi) {
  return /^10\.1109\//i.test(doi);
}

export async function ieeeOaFetch(doi, { apiKey } = {}) {
  if (!isIeeeDoi(doi)) return { found: false, reason: "Not an IEEE DOI" };
  if (!apiKey) return { found: false, reason: "IEEE API key not configured" };

  const metaUrl = `https://ieeexploreapi.ieee.org/api/v1/search/articles?apikey=${encodeURIComponent(apiKey)}&doi=${encodeURIComponent(doi)}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) return { found: false, status: metaRes.status };

  let meta;
  try { meta = await metaRes.json(); } catch { return { found: false, reason: "Bad JSON from IEEE" }; }

  const article = meta.articles?.[0];
  if (!article) return { found: false, reason: "Not found in IEEE Xplore" };

  // IEEE marks OA papers with open_access_flag === "Y" or similar; pdf_url is only
  // populated for OA content the key has access to.
  const pdfUrl = article.pdf_url;
  if (!pdfUrl) {
    return { found: false, reason: "Not Open Access in IEEE Xplore" };
  }

  const pdfRes = await fetch(pdfUrl, { redirect: "follow" });
  if (!pdfRes.ok) return { found: false, status: pdfRes.status };

  const blob = await pdfRes.blob();
  if (blob.type.includes("pdf") || blob.size > 10000) {
    return { found: true, blob, title: article.title };
  }
  return { found: false, reason: "Response was not a PDF" };
}
