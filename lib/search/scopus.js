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
  let lastError = null;

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
      lastError = `network error: ${e.message}`;
      console.warn("Scopus search network error:", e);
      break;
    }

    if (!res.ok) {
      // Read the error body to give the user a useful message.
      let body = "";
      try { body = await res.text(); } catch {}
      // Scopus rate-limit headers: X-RateLimit-Remaining, X-RateLimit-Reset
      const remaining = res.headers.get("X-RateLimit-Remaining");
      const reset = res.headers.get("X-RateLimit-Reset");
      lastError = `Scopus returned ${res.status}${remaining ? ` (${remaining} req remaining)` : ""}: ${body.slice(0, 200)}`;
      console.warn(lastError);

      // 429 = explicit rate-limit; back off and retry once.
      if (res.status === 429) {
        const waitMs = reset ? Math.max(0, (parseInt(reset, 10) * 1000) - Date.now()) : 8000;
        console.info(`Scopus 429, waiting ${Math.min(waitMs, 30000)}ms before retry`);
        await new Promise((r) => setTimeout(r, Math.min(waitMs, 30000)));
        start -= BATCH_SIZE; // Retry this batch.
        continue;
      }

      // 401/403 = key invalid or quota exhausted — stop entirely.
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Scopus auth/quota error (${res.status}): your key may be invalid or you've hit your weekly download quota.`);
      }
      break;
    }

    let data;
    try { data = await res.json(); } catch (e) { lastError = `bad JSON: ${e.message}`; break; }

    const results = data["search-results"] || {};
    total = parseInt(results["opensearch:totalResults"], 10) || 0;
    const entries = results.entry || [];

    // Scopus returns a single error-keyed entry on no results or service errors.
    if (!entries.length) break;
    if (entries[0].error) {
      // Empty page after some results is "end of results", not a hard error.
      if (items.length > 0) break;
      throw new Error(`Scopus: ${entries[0].error}`);
    }

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
    // Scopus documents ~9 req/sec ceiling on the search endpoint; we use 250ms
    // (~4 req/sec) to leave plenty of headroom.
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!items.length && lastError) {
    throw new Error(lastError);
  }
  return { items, total, source: "scopus" };
}
