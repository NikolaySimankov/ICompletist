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

export async function startRun(items, { kind = "fetch", spec = null, sources = null, queries = null } = {}) {
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
  runs.push(run);
  const trimmed = runs.length > MAX_RUNS ? runs.slice(-MAX_RUNS) : runs;
  await chrome.storage.local.set({ [KEY]: trimmed });
  return run.id;
}

export async function appendToRun(runId, entry) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
  const run = runs.find((r) => r.id === runId);
  if (!run) return;
  run.results.push({
    doi: entry.doi,
    source: entry.source,
    filename: entry.filename || null,
    publisher: entry.publisher || null,
    error: entry.error || null,
    tryUrls: Array.isArray(entry.tryUrls) ? entry.tryUrls : null,
    // Pull through any rich metadata returned by the fetch handlers:
    // Unpaywall and CORE return titles; arXiv returns arxivId; Unpaywall
    // returns license; handleDoi tags `via` with the source that succeeded.
    // Without this, RIS export for fetch-mode runs loses everything but
    // the DOI and the local filename.
    title: entry.title || null,
    via: entry.via || null,
    license: entry.license || null,
    pmcid: entry.pmcid || null,
    arxivId: entry.arxivId || null,
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
