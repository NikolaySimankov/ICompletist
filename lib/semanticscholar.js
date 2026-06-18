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

    // Try up to 3 times with exponential backoff on 429.
    let res;
    let attempt = 0;
    while (attempt < 3) {
      try {
        res = await fetch(url, { method: "POST", headers, body });
      } catch (e) {
        console.warn("S2 batch network error:", e);
        res = null;
        break;
      }
      if (res.status !== 429) break;

      // Respect Retry-After if present, else exponential backoff.
      const retryAfter = parseInt(res.headers.get("Retry-After") || "", 10);
      const waitMs = !isNaN(retryAfter) ? retryAfter * 1000 : Math.min(2000 * Math.pow(2, attempt), 15000);
      console.info(`S2 returned 429, waiting ${waitMs}ms before retry ${attempt + 1}/3${apiKey ? "" : " (set an S2 API key in Settings to avoid this)"}`);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt++;
    }

    if (!res || !res.ok) {
      console.warn("S2 batch giving up after status", res?.status);
      continue; // Skip this batch; rest of pipeline will handle these DOIs normally.
    }

    let papers;
    try { papers = await res.json(); } catch { continue; }

    batch.forEach((doi, i) => {
      const p = papers[i];
      if (!p) return;
      if (!p.isOpenAccess || !p.openAccessPdf?.url) {
        result.set(doi, null);
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
