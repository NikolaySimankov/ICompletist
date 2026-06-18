// lib/search/core.js - CORE.ac.uk search adapter.
//
// API: https://api.core.ac.uk/v3/search/works
// Lucene-like query syntax: title:"term" OR abstract:"term" AND yearPublished:[2020 TO 2024]
// Auth: Bearer token in Authorization header.

const FIELD_MAP = {
  "title": ["title"],
  "title-abs": ["title", "abstract"],
  "title-abs-keywords": ["title", "abstract", "keywords"],
  "all": null, // unscoped
};

const PAGE_SIZE = 100;

function quote(t) { return `"${t.replace(/"/g, '\\"')}"`; }

export function buildQuery(spec) {
  const fields = FIELD_MAP[spec.field] || ["title", "abstract"];
  const groups = spec.groups || [];
  if (!groups.length) return "";

  const renderGroup = (g) => {
    const op = g.internal || "OR";
    let perField;
    if (fields) {
      // Each term tagged across each field, OR'd within a field.
      perField = g.terms.flatMap((t) =>
        fields.map((f) => `${f}:${quote(t)}`)
      );
      // Within a group, when internal=OR every (term × field) is OR'd.
      // When internal=AND, each TERM is AND'd, but for that term we still OR
      // across its fields.
      if (op === "AND") {
        const perTerm = g.terms.map((t) =>
          "(" + fields.map((f) => `${f}:${quote(t)}`).join(" OR ") + ")"
        );
        return "(" + perTerm.join(" AND ") + ")";
      }
      return "(" + perField.join(" OR ") + ")";
    }
    // No field scoping → just join the bare terms.
    return "(" + g.terms.map(quote).join(` ${op} `) + ")";
  };

  let q = renderGroup(groups[0]);
  for (const g of groups.slice(1)) {
    let ext = g.external || "AND";
    if (ext === "NOT") ext = "AND NOT";
    if (ext === "AND NOT") {
      q = `${q} AND NOT ${renderGroup(g)}`;
    } else {
      q = `${q} ${ext} ${renderGroup(g)}`;
    }
  }

  if (spec.yearFrom || spec.yearTo) {
    const a = spec.yearFrom || "*";
    const b = spec.yearTo || "*";
    q += ` AND yearPublished:[${a} TO ${b}]`;
  }

  // documentType filter — CORE field is `documentType`.
  if (Array.isArray(spec.doctype) && spec.doctype.length) {
    const map = { "article": "research", "review": "research", "conference-paper": "research", "book-chapter": "research" };
    const mapped = [...new Set(spec.doctype.map((d) => map[d]).filter(Boolean))];
    if (mapped.length) q += ` AND (${mapped.map((m) => `documentType:${m}`).join(" OR ")})`;
  }

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
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn("CORE search returned", res.status);
      break;
    }
    const data = await res.json();
    total = data.totalHits || 0;
    const results = data.results || [];
    if (!results.length) break;

    for (const w of results) {
      const doi = w.doi ? String(w.doi).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "") : null;
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
