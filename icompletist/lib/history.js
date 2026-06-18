// lib/history.js - Run-based history in chrome.storage.local.
//
// A "run" is one batch (one "Fetch articles" click). We keep the last
// MAX_RUNS runs and discard older ones.

const KEY = "runs";
const MAX_RUNS = 10;

export async function startRun(dois) {
  const { [KEY]: runs = [] } = await chrome.storage.local.get({ [KEY]: [] });
  const run = {
    id: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    total: dois.length,
    results: [],
  };
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
    at: Date.now(),
  });
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
