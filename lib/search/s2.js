// lib/search/s2.js - Semantic Scholar search adapter.
//
// API: https://api.semanticscholar.org/graph/v1/paper/search/bulk
// (Bulk endpoint allows up to 1000 results; the regular /search endpoint caps
// at 100 with offset paging. /bulk is faster and what we want here.)
//
// S2's query syntax is much simpler than boolean DBs: a single query string
// where words are AND'd, "phrases in quotes" are exact, and a leading
// minus excludes. There's no field selector, but the `fields` URL param
// limits what's returned in the response.

const FIELDS = "paperId,externalIds,title,abstract,year,venue,authors,openAccessPdf";

function flattenGroupsToString(spec) {
  // S2's bulk query is a single string. We flatten groups into the closest
  // approximation: all positive terms become space-separated (AND-ish), terms
  // inside an OR group are joined with " | " (S2's OR syntax), and AND NOT
  // groups become "-term".
  const groups = spec.groups || [];
  const parts = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const isNot = (g.external || "").includes("NOT");
    const internal = g.internal || "OR";
    const wrappedTerms = g.terms.map((t) => /\s/.test(t) ? `"${t}"` : t);

    if (isNot) {
      // Each excluded term is prefixed with -, joined by spaces.
      parts.push(wrappedTerms.map((t) => `-${t}`).join(" "));
    } else if (internal === "OR" && wrappedTerms.length > 1) {
      // S2 supports the | operator for OR within a parenthesized group.
      parts.push(`(${wrappedTerms.join(" | ")})`);
    } else {
      // AND-internal or single-term groups: just list them.
      parts.push(wrappedTerms.join(" "));
    }
  }
  return parts.join(" ");
}

export function buildQuery(spec) {
  return flattenGroupsToString(spec);
}

export async function search(query, { apiKey, limit = 1000, yearFrom, yearTo, doctype, onProgress } = {}) {
  if (!query) return { items: [], total: 0, source: "semanticscholar" };

  const params = new URLSearchParams({
    query,
    fields: FIELDS,
    limit: String(Math.min(1000, limit)),
  });
  if (yearFrom || yearTo) {
    const a = yearFrom || "";
    const b = yearTo || "";
    params.set("year", `${a}-${b}`);
  }
  // S2 supports `publicationTypes`, comma-separated, e.g. JournalArticle,Review
  if (Array.isArray(doctype) && doctype.length) {
    const map = { "article": "JournalArticle", "review": "Review", "conference-paper": "Conference" };
    const mapped = doctype.map((d) => map[d]).filter(Boolean);
    if (mapped.length) params.set("publicationTypes", mapped.join(","));
  }

  const items = [];
  let token = null;
  let totalGuess = 0;
  let calls = 0;

  while (items.length < limit) {
    if (token) params.set("token", token);
    const url = `https://api.semanticscholar.org/graph/v1/paper/search/bulk?${params}`;
    const headers = {};
    if (apiKey) headers["X-API-KEY"] = apiKey;

    // Retry on 429 with backoff.
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, { headers });
      if (res.status !== 429) break;
      const wait = Math.min(2000 * Math.pow(2, attempt), 15000);
      console.info(`S2 search 429, waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!res.ok) {
      console.warn("S2 search returned", res.status);
      break;
    }

    const data = await res.json();
    totalGuess = data.total || items.length + (data.data?.length || 0);
    for (const p of data.data || []) {
      const ext = p.externalIds || {};
      items.push({
        source: "semanticscholar",
        s2Id: p.paperId || null,
        doi: ext.DOI ? String(ext.DOI).toLowerCase() : null,
        pmid: ext.PubMed || null,
        arxivId: ext.ArXiv || null,
        title: p.title || null,
        abstract: p.abstract || null,
        year: p.year || null,
        journal: p.venue || null,
        authors: (p.authors || []).map((a) => a.name).filter(Boolean),
        openAccessUrl: p.openAccessPdf?.url || null,
      });
      if (items.length >= limit) break;
    }
    if (onProgress) onProgress({ done: items.length, total: totalGuess });

    token = data.token || null;
    calls++;
    if (!token || items.length >= limit || calls > 20) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  return { items, total: totalGuess, source: "semanticscholar" };
}
