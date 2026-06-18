// lib/search/core.js - CORE.ac.uk search adapter.
//
// API: https://api.core.ac.uk/v3/search/works
// Auth: Bearer token in Authorization header.
//
// CORE's query language requires every keyword to be prefixed with a
// field name — bare terms return zero hits. We expand each term across
// title, abstract, and fullText so the search covers the same surface
// the implicit default-field used to cover. Range queries use
// comparison operators (>=, <=), not Lucene bracket syntax.
//
// CORE has no "keywords" field — it has `subjects`, `topics`, and
// `documentType`. Trying to tag terms as `keywords:foo` returns zero hits.

const PAGE_SIZE = 100;
const SEARCH_FIELDS = ["title", "abstract", "fullText"];

// Wrap multi-word terms in quotes; leave single words bare.
function quote(t) {
  return /\s/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
}

// Each term must carry a field prefix, so expand it across the
// searchable fields with OR.
function fieldedTerm(t) {
  const v = quote(t);
  return "(" + SEARCH_FIELDS.map((f) => `${f}:${v}`).join(" OR ") + ")";
}

export function buildQuery(spec) {
  const groups = spec.groups || [];
  if (!groups.length) return "";

  const renderGroup = (g) => {
    const op = g.internal || "OR";
    const parts = g.terms.map(fieldedTerm);
    return "(" + parts.join(` ${op} `) + ")";
  };

  let q = renderGroup(groups[0]);
  for (const g of groups.slice(1)) {
    let ext = g.external || "AND";
    if (ext === "NOT") ext = "AND NOT";
    q = `${q} ${ext} ${renderGroup(g)}`;
  }

  const yearParts = [];
  if (spec.yearFrom) yearParts.push(`yearPublished>=${spec.yearFrom}`);
  if (spec.yearTo) yearParts.push(`yearPublished<=${spec.yearTo}`);
  if (yearParts.length) q += ` AND ${yearParts.join(" AND ")}`;

  return q;
}

export async function search(query, { apiKey, limit = 1000, onProgress } = {}) {
  if (!apiKey) throw new Error("CORE search requires an API key.");
  if (!query) return { items: [], total: 0, source: "core" };

  const items = [];
  let total = 0;
  let offset = 0;

  while (items.length < limit) {
    const params = new URLSearchParams({
      q: query,
      limit: String(Math.min(PAGE_SIZE, limit - items.length)),
      offset: String(offset),
    });
    const url = `https://api.core.ac.uk/v3/search/works?${params}`;

    let res;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (e) {
      console.warn("CORE search network error:", e);
      break;
    }
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch {}
      console.warn(`CORE search returned ${res.status}: ${body.slice(0, 200)}`);
      throw new Error(`CORE returned ${res.status}`);
    }

    const data = await res.json();
    total = data.totalHits || 0;
    const results = data.results || [];
    if (!results.length) break;

    for (const w of results) {
      const doi = w.doi
        ? String(w.doi).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
        : null;
      items.push({
        source: "core",
        coreId: w.id || null,
        doi,
        title: w.title || null,
        abstract: w.abstract || null,
        year: w.yearPublished || null,
        journal: w.publisher || null,
        authors: (w.authors || []).map((a) => a.name).filter(Boolean),
        openAccessUrl: w.downloadUrl || null,
        sourceUrl: w.sourceFulltextUrls?.[0] || null,
      });
      if (items.length >= limit) break;
    }

    if (onProgress) onProgress({ done: items.length, total });
    offset += results.length;
    if (results.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  return { items, total, source: "core" };
}
