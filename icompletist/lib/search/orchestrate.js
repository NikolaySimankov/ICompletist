// lib/search/orchestrate.js - Parallel multi-source dispatch + deduplication.
//
// Given a spec, hits every enabled source concurrently and merges the results
// into a single deduplicated array. Each merged item keeps a `sources` array
// of which DBs contributed to it, plus identifiers from any of them.

import * as pubmed from "./pubmed.js";
import * as scopus from "./scopus.js";
import * as s2 from "./s2.js";
import * as core from "./core.js";

export const ALL_SOURCES = ["pubmed", "scopus", "semanticscholar", "core"];

const SOURCE_MOD = {
  pubmed,
  scopus,
  semanticscholar: s2,
  core,
};

// Produce a canonical identity key for an item, used for dedup.
// Priority: DOI > arXiv > PubMed PMID > S2 paperId > title-hash.
function identityKey(item) {
  if (item.doi) return `doi:${item.doi.toLowerCase()}`;
  if (item.arxivId) return `arxiv:${item.arxivId.toLowerCase()}`;
  if (item.pmid) return `pmid:${item.pmid}`;
  if (item.s2Id) return `s2:${item.s2Id}`;
  if (item.coreId) return `core:${item.coreId}`;
  if (item.scopusId) return `scopus:${item.scopusId}`;
  if (item.title) {
    // Normalize title: lowercase, strip non-alphanumeric, collapse whitespace.
    const norm = item.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (norm.length > 30) return `title:${norm}`;
  }
  return `_orphan:${Math.random()}`;
}

// Merge a new hit into an existing record, preferring non-null fields and
// recording the source.
function mergeInto(target, incoming) {
  const fields = [
    "doi", "pmid", "pmcid", "arxivId", "scopusId", "eid", "s2Id", "coreId",
    "title", "abstract", "year", "journal", "volume", "pages", "citedBy",
    "openAccess", "openAccessUrl", "articleType", "sourceUrl",
  ];
  for (const f of fields) {
    if (target[f] == null && incoming[f] != null) target[f] = incoming[f];
  }
  // Authors: take the longer non-empty list.
  if (Array.isArray(incoming.authors) && incoming.authors.length > (target.authors?.length || 0)) {
    target.authors = incoming.authors;
  }
  // Record the source.
  if (!target.sources.includes(incoming.source)) target.sources.push(incoming.source);
}

// Build per-source query strings for one spec.
export function buildQueries(spec) {
  return {
    pubmed: pubmed.buildQuery(spec),
    scopus: scopus.buildQuery(spec),
    semanticscholar: s2.buildQuery(spec),
    core: core.buildQuery(spec),
  };
}

// Run search across the enabled sources in parallel.
//
// opts: {
//   sources: ["pubmed", "scopus", ...],   // which to run
//   limit: per-source soft cap (default 1000),
//   settings: full settings object from chrome.storage,
//   spec: the original spec (needed for S2 year filter, which goes in URL not query),
//   onSourceProgress(src, {done, total}),
//   onSourceComplete(src, {items, total, error}),
// }
//
// Returns { items, perSource, queries }.
export async function runSearch(spec, opts = {}) {
  const sources = opts.sources || ALL_SOURCES;
  const limit = opts.limit || 1000;
  const settings = opts.settings || {};
  const queries = buildQueries(spec);

  // Per-source options.
  const sourceOpts = {
    pubmed: { email: settings.email, apiKey: settings.ncbiApiKey, limit },
    scopus: { apiKey: settings.elsevierKey, limit },
    semanticscholar: { apiKey: settings.s2ApiKey, limit, yearFrom: spec.yearFrom, yearTo: spec.yearTo, doctype: spec.doctype },
    core: { apiKey: settings.coreApiKey, limit },
  };

  const perSource = {};
  const tasks = sources.map(async (src) => {
    const mod = SOURCE_MOD[src];
    if (!mod) return;
    const q = queries[src];
    const o = {
      ...sourceOpts[src],
      onProgress: (p) => { if (opts.onSourceProgress) opts.onSourceProgress(src, p); },
    };
    try {
      const r = await mod.search(q, o);
      perSource[src] = { items: r.items, total: r.total, error: null };
      if (opts.onSourceComplete) opts.onSourceComplete(src, perSource[src]);
    } catch (e) {
      console.warn(`Search source ${src} failed:`, e);
      perSource[src] = { items: [], total: 0, error: e.message };
      if (opts.onSourceComplete) opts.onSourceComplete(src, perSource[src]);
    }
  });
  await Promise.all(tasks);

  // Dedup across sources.
  const byKey = new Map();
  for (const src of sources) {
    const r = perSource[src];
    if (!r || !r.items) continue;
    for (const item of r.items) {
      const key = identityKey(item);
      if (!byKey.has(key)) {
        byKey.set(key, {
          id: key,
          sources: [],
          doi: null, pmid: null, pmcid: null, arxivId: null,
          scopusId: null, eid: null, s2Id: null, coreId: null,
          title: null, abstract: null, year: null, journal: null,
          volume: null, pages: null, citedBy: null,
          openAccess: false, openAccessUrl: null,
          articleType: null, sourceUrl: null, authors: [],
        });
      }
      mergeInto(byKey.get(key), item);
    }
  }

  // Sort newest-first as a useful default.
  const items = [...byKey.values()].sort((a, b) => (b.year || 0) - (a.year || 0));

  return { items, perSource, queries };
}
