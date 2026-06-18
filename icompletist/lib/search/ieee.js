// lib/search/ieee.js - IEEE Xplore search adapter.
//
// API: https://ieeexploreapi.ieee.org/api/v1/search/articles
// Auth: apikey query param. Free key from https://developer.ieee.org/
//
// IEEE's API is "metadata-only" by default — abstracts come back in the
// `abstract` field when available. The query syntax supports field-tagged
// terms via `index_terms`, `article_title`, `abstract`, plus boolean
// AND/OR/NOT. The convenience parameter `meta_data:"..."` searches
// title + abstract + index terms together, which we use here to avoid the
// term-vs-field cross-product that breaks CORE.
//
// Note: IEEE caps responses at 200 per call (max_records=200), and there's
// a daily call quota tied to the key.

const FIELD_MAP = {
  // Each spec field maps to an IEEE-supported field operator.
  "title": "article_title",
  "title-abs": "meta_data", // closest IEEE has — searches title + abstract + index_terms
  "title-abs-keywords": "meta_data",
  "all": null, // unscoped — every IEEE field
};

const DOCTYPE_MAP = {
  "article": "Journals",
  "review": "Journals",
  "conference-paper": "Conferences",
  "book-chapter": "Books",
};

const PAGE_SIZE = 200;

function quote(t) { return `"${t.replace(/"/g, '\\"')}"`; }

export function buildQuery(spec) {
  const fieldKey = FIELD_MAP[spec.field] ?? "meta_data";
  const groups = spec.groups || [];
  if (!groups.length) return "";

  const renderGroup = (g) => {
    const op = g.internal || "OR";
    const tagged = g.terms.map((t) =>
      fieldKey ? `${fieldKey}:${quote(t)}` : quote(t)
    );
    return "(" + tagged.join(` ${op} `) + ")";
  };

  let q = renderGroup(groups[0]);
  for (const g of groups.slice(1)) {
    let ext = g.external || "AND";
    if (ext === "NOT") ext = "NOT";       // IEEE uses bare NOT, not AND NOT
    if (ext === "AND NOT") ext = "NOT";
    q = `${q} ${ext} ${renderGroup(g)}`;
  }
  return q;
}

export async function search(query, { apiKey, limit = 1000, yearFrom, yearTo, doctype, onProgress } = {}) {
  if (!apiKey) throw new Error("IEEE Xplore search requires an API key.");
  if (!query) return { items: [], total: 0, source: "ieee" };

  const items = [];
  let total = 0;
  let lastError = null;

  for (let start = 1; start <= limit; start += PAGE_SIZE) {
    const params = new URLSearchParams({
      apikey: apiKey,
      querytext: query,
      max_records: String(Math.min(PAGE_SIZE, limit - items.length)),
      start_record: String(start),
      format: "json",
    });
    if (yearFrom) params.set("start_year", String(yearFrom));
    if (yearTo) params.set("end_year", String(yearTo));
    if (Array.isArray(doctype) && doctype.length) {
      // IEEE accepts only one content_type per call. If multiple are
      // requested, drop the filter (let everything through) — simpler than
      // making multiple paginated queries.
      const mapped = [...new Set(doctype.map((d) => DOCTYPE_MAP[d]).filter(Boolean))];
      if (mapped.length === 1) params.set("content_type", mapped[0]);
    }

    const url = `https://ieeexploreapi.ieee.org/api/v1/search/articles?${params}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      lastError = `network error: ${e.message}`;
      console.warn("IEEE search network error:", e);
      break;
    }
    if (!res.ok) {
      let body = "";
      try { body = await res.text(); } catch {}
      lastError = `IEEE returned ${res.status}: ${body.slice(0, 200)}`;
      console.warn(lastError);
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 10000));
        start -= PAGE_SIZE;
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`IEEE auth/quota error (${res.status}): check API key.`);
      }
      break;
    }

    let data;
    try { data = await res.json(); } catch (e) { lastError = `bad JSON: ${e.message}`; break; }

    total = data.total_records || 0;
    const articles = data.articles || [];
    if (!articles.length) break;

    for (const a of articles) {
      const doi = a.doi ? String(a.doi).toLowerCase() : null;
      items.push({
        source: "ieee",
        ieeeArticleNumber: a.article_number || null,
        doi,
        pmid: null,
        title: a.title || null,
        abstract: a.abstract || null,
        year: a.publication_year ? parseInt(a.publication_year, 10) : null,
        journal: a.publication_title || null,
        authors: Array.isArray(a.authors?.authors)
          ? a.authors.authors.map((x) => x.full_name).filter(Boolean)
          : [],
        citedBy: a.citing_paper_count ?? null,
        openAccess: a.open_access === true || a.access_type === "OPEN_ACCESS",
        articleType: a.content_type || null,
        sourceUrl: a.html_url || null,
      });
      if (items.length >= limit) break;
    }

    if (onProgress) onProgress({ done: items.length, total });

    if (articles.length < PAGE_SIZE || items.length >= Math.min(total, limit)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!items.length && lastError) throw new Error(lastError);
  return { items, total, source: "ieee" };
}
