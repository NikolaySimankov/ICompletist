// lib/history.js - Run-based history in chrome.storage.local.
//
// A "run" is one user action (one "Fetch articles" click or one search). We
// keep the last MAX_RUNS runs and discard older ones.
//
// Two kinds of runs:
//   kind: "fetch"   — items are identifiers being downloaded
//   kind: "search"  — items are search results from one or more DBs

const KEY = "runs";
const MAX_RUNS = 10;

// Serialize every read-modify-write against chrome.storage.local. chrome.storage
// has no atomic update, so concurrent workers (5 in the pool) finishing at the
// same instant would each get→modify→set the runs array and the later set()
// would clobber the earlier one — silently dropping results from history and
// therefore from RIS export (the "lost one result" bug). mutate() funnels every
// get→modify→set through a single promise chain so they run one at a time.
let _chain = Promise.resolve();
function mutate(mutator) {
  const next = _chain.then(async () => {
    const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
    const result = await mutator(runs);
    await chrome.storage.local.set({ [KEY]: runs });
    return result;
  });
  _chain = next.then(() => {}, () => {}); // keep the chain alive even if a task throws
  return next;
}

export function startRun(items, { kind = "fetch", spec = null, sources = null, queries = null, subfolder = null, ensure = null } = {}) {
  return mutate((runs) => {
    const run = {
      id: Date.now(),
      kind,
      startedAt: Date.now(),
      finishedAt: null,
      total: items.length,
      results: [],
    };
    if (spec) run.spec = spec;
    if (sources) run.sources = sources;
    if (queries) run.queries = queries;
    if (subfolder) run.subfolder = subfolder;
    if (ensure !== null) run.ensure = ensure;
    // Persist the input items (and target subfolder) for fetch runs so an
    // interrupted run can be resumed: we re-process only the items that never
    // produced a result.
    if (kind === "fetch" && Array.isArray(items) && items.length) run.items = items;
    runs.push(run);
    if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS);
    return run.id;
  });
}

export function appendToRun(runId, entry) {
  return mutate((runs) => {
    const run = runs.find((r) => r.id === runId);
    if (!run) return;
    // A "real" DOI (10.x/...) goes into the identifiers block so RIS export
    // treats it identically to a search-mode result; arXiv/OpenReview display
    // strings are left for risexport's prefix handling.
    const realDoi = /^10\.\d{4,9}\//i.test(String(entry.doi || "")) ? entry.doi : null;
    run.results.push({
      doi: entry.doi,
      // Original input string this result came from — the join key used to
      // figure out which items still need processing when resuming a run.
      original: entry.original || null,
      source: entry.source,
      filename: entry.filename || null,
      publisher: entry.publisher || null,
      error: entry.error || null,
      tryUrls: Array.isArray(entry.tryUrls) ? entry.tryUrls : null,
      // Full bibliographic record — populated by the ENRICH (Crossref) stage
      // and by whatever the fetch handlers returned (Unpaywall/CORE titles,
      // licenses, `via`). This is what makes fetch-mode RIS identical to
      // search-mode RIS.
      title: entry.title || null,
      authors: Array.isArray(entry.authors) ? entry.authors : [],
      year: entry.year || null,
      journal: entry.journal || null,
      volume: entry.volume || null,
      pages: entry.pages || null,
      abstract: entry.abstract || null,
      keywords: Array.isArray(entry.keywords) ? entry.keywords : null,
      via: entry.via || null,
      license: entry.license || null,
      sourceUrl: entry.sourceUrl || null,
      openAccessUrl: entry.openAccessUrl || null,
      identifiers: {
        doi: realDoi,
        pmid: entry.pmid || null,
        pmcid: entry.pmcid || null,
        arxivId: entry.arxivId || null,
      },
      at: Date.now(),
    });
  });
}

// Used by search runs that produce all items at once.
export function replaceRunResults(runId, results) {
  return mutate((runs) => {
    const run = runs.find((r) => r.id === runId);
    if (!run) return;
    run.results = results;
    run.total = results.length;
  });
}

// Patch a single result in a run (used by the guided manual-attach flow:
// turn an "unavailable" item into a "manual" one once the user supplies the
// PDF). Matches by doi, merges `patch`, and recomputes the fetch-run summary
// so the stats / history label stay accurate.
export function updateRunResult(runId, doi, patch) {
  return mutate((runs) => {
    const run = runs.find((r) => r.id === runId);
    if (!run) return false;
    const res = run.results.find((r) => r.doi === doi);
    if (!res) return false;
    Object.assign(res, patch);
    if (run.kind !== "search") {
      const summary = {};
      for (const r of run.results) summary[r.source] = (summary[r.source] || 0) + 1;
      run.summary = summary;
    }
    return true;
  });
}

// Remove results from a run (keepFn returns true for results to keep), then
// recompute the summary so stats + RIS export reflect the curated set.
// Returns the number removed.
function filterRunResults(runId, keepFn) {
  return mutate((runs) => {
    const run = runs.find((r) => r.id === runId);
    if (!run) return 0;
    const before = run.results.length;
    run.results = run.results.filter(keepFn);
    const removed = before - run.results.length;
    if (!removed) return 0;
    run.total = run.results.length;
    if (run.kind !== "search") {
      const summary = {};
      for (const r of run.results) summary[r.source] = (summary[r.source] || 0) + 1;
      run.summary = summary;
    } else if (run.summary) {
      run.summary.total = run.results.length;
    }
    return removed;
  });
}

export function removeRunResult(runId, doi) {
  return filterRunResults(runId, (r) => r.doi !== doi);
}

export function removeUnavailableResults(runId) {
  return filterRunResults(runId, (r) => r.source !== "unavailable");
}

export function finishRun(runId, summary) {
  return mutate((runs) => {
    const run = runs.find((r) => r.id === runId);
    if (!run) return;
    run.finishedAt = Date.now();
    run.summary = summary;
  });
}

export async function getRuns() {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
  return runs;
}

export function clearRuns() {
  return mutate((runs) => { runs.length = 0; });
}

export function deleteRun(runId) {
  return mutate((runs) => {
    const i = runs.findIndex((r) => r.id === runId);
    if (i >= 0) runs.splice(i, 1);
  });
}
