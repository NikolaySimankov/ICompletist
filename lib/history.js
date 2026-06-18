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

export async function startRun(items, { kind = "fetch", spec = null, sources = null, queries = null, subfolder = null, ensure = null } = {}) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
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
  const trimmed = runs.length > MAX_RUNS ? runs.slice(-MAX_RUNS) : runs;
  await chrome.storage.local.set({ [KEY]: trimmed });
  return run.id;
}

export async function appendToRun(runId, entry) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
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
  await chrome.storage.local.set({ [KEY]: runs });
}

// Used by search runs that produce all items at once.
export async function replaceRunResults(runId, results) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
  const run = runs.find((r) => r.id === runId);
  if (!run) return;
  run.results = results;
  run.total = results.length;
  await chrome.storage.local.set({ [KEY]: runs });
}

// Patch a single result in a run (used by the guided manual-attach flow:
// turn an "unavailable" item into a "manual" one once the user supplies the
// PDF). Matches by doi, merges `patch`, and recomputes the fetch-run summary
// so the stats / history label stay accurate.
export async function updateRunResult(runId, doi, patch) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
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
  await chrome.storage.local.set({ [KEY]: runs });
  return true;
}

// Remove results from a run (keepFn returns true for results to keep), then
// recompute the summary so stats + RIS export reflect the curated set.
// Returns the number removed.
async function filterRunResults(runId, keepFn) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
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
  await chrome.storage.local.set({ [KEY]: runs });
  return removed;
}

export async function removeRunResult(runId, doi) {
  return filterRunResults(runId, (r) => r.doi !== doi);
}

export async function removeUnavailableResults(runId) {
  return filterRunResults(runId, (r) => r.source !== "unavailable");
}

export async function finishRun(runId, summary) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
  const run = runs.find((r) => r.id === runId);
  if (!run) return;
  run.finishedAt = Date.now();
  run.summary = summary;
  await chrome.storage.local.set({ [KEY]: runs });
}

export async function getRuns() {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
  return runs;
}

export async function clearRuns() {
  await chrome.storage.local.set({ [KEY]: [] });
}

export async function deleteRun(runId) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
  await chrome.storage.local.set({ [KEY]: runs.filter((r) => r.id !== runId) });
}
