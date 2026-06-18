// lib/semanticscholar.js - Batch OA-URL lookup via Semantic Scholar.
//
// S2's POST /graph/v1/paper/batch accepts up to 500 paper IDs at once. For
// DOIs, prefix them with "DOI:" per the S2 spec.
// Docs: https://api.semanticscholar.org/api-docs/graph
//
// A free API key is available at https://www.semanticscholar.org/product/api
// — keys raise rate limits significantly. The endpoint also works WITHOUT
// a key at lower rate limits, which is why we don't make it required.

const BATCH_SIZE = 500;
const ENDPOINT = "https://api.semanticscholar.org/graph/v1/paper/batch";

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Look up OA PDF URLs for many DOIs in one (or a few) batched requests.
// Returns a Map<doi, {url, license, title}|null> where null = paper found but
// no OA URL available, and missing keys = paper not in S2.
export async function s2BatchLookup(dois, { apiKey } = {}) {
  const result = new Map();
  if (!dois.length) return result;

  for (const batch of chunk(dois, BATCH_SIZE)) {
    const params = new URLSearchParams({ fields: "paperId,isOpenAccess,openAccessPdf,title" });
    const url = `${ENDPOINT}?${params}`;
    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["X-API-KEY"] = apiKey;

    const body = JSON.stringify({ ids: batch.map((d) => `DOI:${d}`) });
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body });
    } catch (e) {
      console.warn("S2 batch network error:", e);
      continue;
    }
    if (!res.ok) {
      console.warn("S2 batch returned", res.status);
      continue;
    }
    let papers;
    try { papers = await res.json(); } catch { continue; }

    // S2 returns nulls for IDs it couldn't resolve, in the same order as input.
    batch.forEach((doi, i) => {
      const p = papers[i];
      if (!p) return; // Not found in S2 — leave map entry absent.
      if (!p.isOpenAccess || !p.openAccessPdf?.url) {
        result.set(doi, null); // Known to S2 but no OA copy.
        return;
      }
      result.set(doi, {
        url: p.openAccessPdf.url,
        license: p.openAccessPdf.license || null,
        title: p.title || null,
      });
    });
  }

  return result;
}
