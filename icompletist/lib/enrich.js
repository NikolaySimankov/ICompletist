// lib/enrich.js - Bibliographic enrichment via Crossref.
//
// The ENRICH stage fills the metadata a result needs for a complete RIS
// record — title, authors, year, journal, volume, pages, abstract,
// keywords — for any item that has a real DOI but is missing some of them.
//
// Why Crossref: it's free, keyless, covers virtually every journal DOI, and
// returns structured author lists + page ranges. It's the first rung of the
// cascade described in the v2 plan (Crossref → PubMed → S2 → Scopus); the
// later rungs can be layered on top of mergeMeta() without changing callers.
//
// This module is used in BOTH modes so RIS export is identical regardless of
// how the item entered the pipeline:
//   - Fetch-by-ID / URL : background.js enriches each result before it is
//                          written to history (per-item, inside the worker
//                          pool, throttled via the shared "crossref" key).
//   - Search-by-query    : enrichItems() enriches the deduplicated array
//                          between DEDUPLICATE and ENSURE.
//
// Crossref asks API users to identify themselves (the "polite pool"); we
// pass the configured email via the mailto query param when available.

const ENDPOINT = "https://api.crossref.org/works/";

// Strip JATS/XML markup Crossref wraps abstracts in (<jats:p>…</jats:p>).
function stripMarkup(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function pickYear(m) {
  const parts =
    m.issued?.["date-parts"]?.[0] ||
    m["published-print"]?.["date-parts"]?.[0] ||
    m["published-online"]?.["date-parts"]?.[0] ||
    m.created?.["date-parts"]?.[0];
  const y = parts?.[0];
  return Number.isInteger(y) ? y : null;
}

// Look up one DOI. Returns a metadata object (fields may be null) or null on
// any failure — callers treat null as "couldn't enrich, leave as-is".
export async function crossrefLookup(doi, email) {
  if (!doi) return null;
  const url = `${ENDPOINT}${encodeURIComponent(doi)}${email ? `?mailto=${encodeURIComponent(email)}` : ""}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    console.warn(`crossref network error for ${doi}:`, e);
    return null;
  }
  if (!res.ok) return null;

  let data;
  try { data = await res.json(); } catch { return null; }
  const m = data.message;
  if (!m) return null;

  return {
    title: Array.isArray(m.title) ? m.title[0] : (m.title || null),
    authors: Array.isArray(m.author)
      ? m.author
          .map((a) => [a.family, a.given].filter(Boolean).join(", ") || a.name || null)
          .filter(Boolean)
      : [],
    year: pickYear(m),
    journal: Array.isArray(m["container-title"]) ? m["container-title"][0] : (m["container-title"] || null),
    volume: m.volume || null,
    pages: m.page || null,
    abstract: m.abstract ? stripMarkup(m.abstract) : null,
    keywords: Array.isArray(m.subject) && m.subject.length ? m.subject : null,
  };
}

// Merge Crossref metadata into a result/item, filling only empty fields so
// the stage is idempotent and never clobbers richer data a search source
// already supplied.
export function mergeMeta(target, meta) {
  if (!target || !meta) return target;
  for (const k of ["title", "year", "journal", "volume", "pages", "abstract"]) {
    const cur = target[k];
    if ((cur == null || cur === "") && meta[k] != null && meta[k] !== "") {
      target[k] = meta[k];
    }
  }
  if (Array.isArray(meta.authors) && meta.authors.length && !(target.authors && target.authors.length)) {
    target.authors = meta.authors;
  }
  if (Array.isArray(meta.keywords) && meta.keywords.length && !(target.keywords && target.keywords.length)) {
    target.keywords = meta.keywords;
  }
  return target;
}

function hasRealDoi(doi) {
  return typeof doi === "string" && /^10\.\d{4,9}\//i.test(doi);
}

// Enrich an array of search items in place. Only items that have a DOI and
// are missing at least one core field are looked up; everything else is
// skipped so we don't burn Crossref calls on already-complete records.
export async function enrichItems(items, { email, onProgress, concurrency = 5 } = {}) {
  const targets = items.filter(
    (it) => it && hasRealDoi(it.doi) &&
      (!it.title || !it.year || !it.journal || !it.abstract)
  );
  if (!targets.length) {
    if (onProgress) onProgress({ done: 0, total: 0 });
    return items;
  }

  let idx = 0;
  let done = 0;
  async function worker() {
    while (idx < targets.length) {
      const it = targets[idx++];
      try {
        const meta = await crossrefLookup(it.doi, email);
        if (meta) mergeMeta(it, meta);
      } catch (e) {
        // Leave the item as-is on failure.
      }
      done++;
      if (onProgress) onProgress({ done, total: targets.length });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, targets.length) }, worker)
  );
  return items;
}
