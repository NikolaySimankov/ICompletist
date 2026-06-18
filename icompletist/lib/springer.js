// lib/springer.js - Springer Nature TDM API.
// Docs: https://dev.springernature.com/ (Open Access API + TDM API)
//
// The free "Open Access" API at api.springernature.com returns OA articles only.
// The full TDM API is granted to subscribing institutions and returns
// licensed content as well; it uses the same key system.

export async function springerTdmFetch(doi, { apiKey } = {}) {
  if (!apiKey) throw new Error("Springer API key not configured.");
  // Springer's TDM endpoint returns metadata + a link to the full text.
  const metaUrl = `https://api.springernature.com/meta/v2/json?q=doi:${encodeURIComponent(doi)}&api_key=${encodeURIComponent(apiKey)}`;
  const metaRes = await fetch(metaUrl);
  if (!metaRes.ok) return { found: false, status: metaRes.status };
  const meta = await metaRes.json();
  const record = meta.records?.[0];
  if (!record) return { found: false, reason: "Not in Springer catalog" };

  const pdfUrl = record.url?.find((u) => u.format === "pdf")?.value;
  if (!pdfUrl) return { found: false, reason: "No PDF link in metadata" };

  const pdfRes = await fetch(pdfUrl);
  if (!pdfRes.ok) return { found: false, status: pdfRes.status };
  const blob = await pdfRes.blob();
  return { found: true, blob, title: record.title };
}
