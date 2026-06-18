// lib/search/scopus.js - Elsevier Scopus Search API adapter.
//
// API: https://api.elsevier.com/content/search/scopus
// Same API key as ScienceDirect TDM (settings.elsevierKey).
// Auth: apiKey query param.
//
// IMPORTANT: Scopus search returns ABSTRACTS only via the separate
// "Abstract Retrieval API" — that's slow (one call per article) and belongs
// in the ENRICH stage, not here. The Search API itself returns a short
// description that's often empty.

const FIELD_MAP = {
  "title": "TITLE",
  "title-abs": "TITLE-ABS",
  "title-abs-keywords": "TITLE-ABS-KEY",
  "all": "ALL",
};

const DOCTYPE_MAP = {
  "article": "ar",
  "review": "re",
  "clinical-trial": null, // Scopus doesn't have this; suppress
  "meta-analysis": "re",  // treated as review in Scopus
  "conference-paper": "cp",
  "book-chapter": "ch",
};

const BATCH_SIZE = 25;

export function buildQuery(spec) {
  const field = FIELD_MAP[spec.field] || "TITLE-ABS-KEY";
  const groups = spec.groups || [];
  if (!groups.length) return "";

  const renderGroup = (g) => {
    const op = g.internal || "OR";
    const tagged = g.terms.map((t) => `${field}("${t}")`);
    return "(" + tagged.join(` ${op} `) + ")";
  };

  let q = renderGroup(groups[0]);
  for (const g of groups.slice(1)) {
    let ext = g.external || "AND";
    if (ext === "NOT") ext = "AND NOT";
    q = `${q} ${ext} ${renderGroup(g)}`;
  }

  // Scopus only supports strict > / < on PUBYEAR; shift bounds for inclusivity.
  if (spec.yearFrom) q += ` AND PUBYEAR > ${spec.yearFrom - 1}`;
  if (spec.yearTo) q += ` AND PUBYEAR < ${spec.yearTo + 1}`;

  if (Array.isArray(spec.doctype) && spec.doctype.length) {
    const codes = spec.doctype.map((d) => DOCTYPE_MAP[d]).filter(Boolean);
    if (codes.length) q += ` AND (${codes.map((c) => `DOCTYPE(${c})`).join(" OR ")})`;
  }

  return q;
}

export async function search(query, { apiKey, limit = 1000, onProgress } = {}) {
  if (!apiKey) throw new Error("Scopus search requires an Elsevier API key.");

  const items = [];
  let total = 0;

  for (let start = 0; start < limit; start += BATCH_SIZE) {
    const params = new URLSearchParams({
      query,
      apiKey,
      httpAccept: "application/json",
      start: String(start),
      count: String(Math.min(BATCH_SIZE, limit - start)),
    });
    const url = `https://api.elsevier.com/content/search/scopus?${params}`;

    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      console.warn("Scopus search network error:", e);
      break;
    }
    if (!res.ok) {
      console.warn("Scopus search returned", res.status);
      break;
    }

    const data = await res.json();
    const results = data["search-results"] || {};
    total = parseInt(results["opensearch:totalResults"], 10) || 0;
    const entries = results.entry || [];

    // Scopus returns a single error-keyed entry on no results.
    if (!entries.length || entries[0].error) break;

    for (const e of entries) {
      const raw = e["prism:coverDate"] || "";
      const year = raw.length >= 4 && /^\d{4}/.test(raw) ? parseInt(raw.slice(0, 4), 10) : null;
      const scopusId = (e["dc:identifier"] || "").replace(/^SCOPUS_ID:/, "");
      const eid = e.eid || null;
      items.push({
        source: "scopus",
        scopusId,
        eid,
        pmid: e["pubmed-id"] || null,
        doi: e["prism:doi"] ? e["prism:doi"].toLowerCase() : null,
        title: e["dc:title"] || null,
        // Scopus search rarely includes an abstract; leave it to the enrich stage.
        year,
        journal: e["prism:publicationName"] || null,
        volume: e["prism:volume"] || null,
        pages: e["prism:pageRange"] || null,
        citedBy: e["citedby-count"] ? parseInt(e["citedby-count"], 10) : null,
        openAccess: e.openaccessFlag === "true",
        articleType: e.subtypeDescription || null,
        sourceUrl: eid ? `https://www.scopus.com/record/display.uri?eid=${eid}` : null,
      });
    }

    if (onProgress) onProgress({ done: items.length, total });

    if (items.length >= Math.min(total, limit)) break;
    // Light pacing.
    await new Promise((r) => setTimeout(r, 150));
  }

  return { items, total, source: "scopus" };
}
