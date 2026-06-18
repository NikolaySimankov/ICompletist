// popup.js - UI controller
import { parseIdentifiers } from "./lib/identifiers.js";
import { buildRis } from "./lib/risexport.js";
import { buildSpec, QueryParseError } from "./lib/search/spec.js";

const $ = (id) => document.getElementById(id);

const ui = {
  input: $("input-section"),
  progress: $("progress-section"),
  results: $("results-section"),
  doisField: $("dois"),
  subfolderField: $("subfolder"),
  fetchBtn: $("fetch-btn"),
  clearBtn: $("clear-btn"),
  cancelBtn: $("cancel-btn"),
  resetBtn: $("reset-btn"),
  settingsBtn: $("settings-btn"),
  progressFill: $("progress-fill"),
  progressText: $("progress-text"),
  resultsList: $("results-list"),
  statPmc: $("stat-pmc"),
  statOa: $("stat-oa"),
  statInst: $("stat-inst"),
  statTdm: $("stat-tdm"),
  statCached: $("stat-cached"),
  statFail: $("stat-fail"),
  historyCount: $("history-count"),
  historyClear: $("history-clear"),
  runSelect: $("run-select"),
  runResults: $("run-results"),
  runActions: $("run-actions"),
  refillBtn: $("refill-btn"),
  exportRunBtn: $("export-run-btn"),
  downloadPdfsBtn: $("download-pdfs-btn"),
  // Search-mode bindings:
  modeIdBtn: $("mode-id-btn"),
  modeSearchBtn: $("mode-search-btn"),
  idPanel: $("id-panel"),
  searchPanel: $("search-panel"),
  queryText: $("query-text"),
  queryError: $("query-error"),
  yearFrom: $("year-from"),
  yearTo: $("year-to"),
  fieldSelect: $("field-select"),
  limitInput: $("limit-input"),
  searchBtn: $("search-btn"),
  searchClearBtn: $("search-clear-btn"),
};

// Restore last-used subfolder on open.
chrome.storage.local.get({ subfolder: "icompletist" }, ({ subfolder }) => {
  ui.subfolderField.value = subfolder;
});

function show(section) {
  ui.input.hidden = section !== "input";
  ui.progress.hidden = section !== "progress";
  ui.results.hidden = section !== "results";
}

function parseDois(text) {
  // Legacy name kept for compatibility — now returns typed identifiers.
  return parseIdentifiers(text);
}

// ---- Mode toggle ----

let currentMode = "id";

function setMode(mode) {
  currentMode = mode;
  ui.modeIdBtn?.classList.toggle("active", mode === "id");
  ui.modeSearchBtn?.classList.toggle("active", mode === "search");
  if (ui.idPanel) ui.idPanel.hidden = mode !== "id";
  if (ui.searchPanel) ui.searchPanel.hidden = mode !== "search";
  chrome.storage.local.set({ mode });
}

ui.modeIdBtn?.addEventListener("click", () => setMode("id"));
ui.modeSearchBtn?.addEventListener("click", () => setMode("search"));

// Restore last-used mode on load.
chrome.storage.local.get({ mode: "id" }, ({ mode }) => setMode(mode));

// ---- Search submission ----

function readSearchInputs() {
  const queryText = ui.queryText?.value || "";
  const yearFrom = ui.yearFrom?.value || null;
  const yearTo = ui.yearTo?.value || null;
  const field = ui.fieldSelect?.value || "title-abs-keywords";
  const doctype = [...document.querySelectorAll(".doctype-cb:checked")].map((el) => el.value);
  const sources = [...document.querySelectorAll(".source-cb:checked")].map((el) => el.value);
  const limit = parseInt(ui.limitInput?.value, 10) || 500;
  return { queryText, yearFrom, yearTo, field, doctype, sources, limit };
}

function showQueryError(msg) {
  if (!ui.queryError) return;
  ui.queryError.textContent = msg;
  ui.queryError.hidden = !msg;
}

ui.searchBtn?.addEventListener("click", async () => {
  showQueryError("");
  const inputs = readSearchInputs();

  if (!inputs.queryText.trim()) {
    showQueryError("Enter at least one query line.");
    return;
  }
  if (!inputs.sources.length) {
    showQueryError("Pick at least one database to search.");
    return;
  }

  let spec;
  try {
    spec = buildSpec(inputs);
  } catch (e) {
    if (e instanceof QueryParseError) {
      showQueryError(e.message);
    } else {
      showQueryError("Query parse error: " + e.message);
    }
    return;
  }

  if (!spec.groups.length) {
    showQueryError("No valid query groups parsed.");
    return;
  }

  show("progress");
  ui.resultsList.innerHTML = "";
  for (const k of ["statPmc", "statOa", "statInst", "statTdm", "statCached", "statFail"]) ui[k].textContent = "0";
  ui.progressFill.style.width = "0%";
  ui.progressText.textContent = `Searching ${inputs.sources.length} database${inputs.sources.length === 1 ? "" : "s"}…`;

  // Replace stats with a per-source progress panel.
  const statsEl = document.querySelector("#progress-section .stats");
  if (statsEl) {
    statsEl.innerHTML = "";
    statsEl.classList.add("search-progress");
    for (const src of inputs.sources) {
      const row = document.createElement("div");
      row.className = "src-row";
      row.innerHTML = `
        <span class="src-name">${src}</span>
        <div class="src-bar"><div data-src="${src}"></div></div>
        <span class="src-status" data-src-status="${src}">queued…</span>
      `;
      statsEl.appendChild(row);
    }
  }

  const port = chrome.runtime.connect({ name: "search-job" });
  port.postMessage({ type: "start", spec, sources: inputs.sources, limit: inputs.limit });

  port.onMessage.addListener((msg) => {
    if (msg.type === "queries") {
      // Optional: log the per-DB queries to console for debugging.
      console.info("Per-source queries:", msg.queries);
    } else if (msg.type === "source-progress") {
      const bar = document.querySelector(`.src-bar > div[data-src="${msg.source}"]`);
      const status = document.querySelector(`[data-src-status="${msg.source}"]`);
      if (msg.total > 0) {
        const pct = Math.min(100, (msg.done / msg.total) * 100);
        if (bar) bar.style.width = `${pct}%`;
      }
      if (status) status.textContent = `${msg.done}${msg.total ? "/" + msg.total : ""}`;
    } else if (msg.type === "source-complete") {
      const bar = document.querySelector(`.src-bar > div[data-src="${msg.source}"]`);
      const status = document.querySelector(`[data-src-status="${msg.source}"]`);
      if (bar) bar.style.width = "100%";
      if (status) {
        if (msg.error) {
          status.textContent = `error`;
          status.title = msg.error;
          status.classList.add("err");
        } else {
          status.textContent = `${msg.items}${msg.total ? "/" + msg.total : ""} found`;
          status.classList.add("done");
        }
      }
    } else if (msg.type === "stage") {
      if (msg.stage === "enrich") {
        ui.progressText.textContent = `Enriching ${msg.before} item${msg.before === 1 ? "" : "s"}…`;
      } else if (msg.stage === "ensure") {
        const dropped = msg.before - msg.after;
        ui.progressText.textContent = `ENSURE filter: ${msg.before} → ${msg.after} (dropped ${dropped}).`;
      }
    } else if (msg.type === "done") {
      let text;
      if (msg.cancelled) {
        text = "Cancelled.";
      } else if (typeof msg.searchCount === "number" && msg.searchCount !== msg.ensureCount) {
        const dropped = msg.searchCount - msg.ensureCount;
        text = `Search complete — ${msg.searchCount} unique → ${msg.ensureCount} kept after ENSURE (precision filter dropped ${dropped}).`;
      } else {
        const n = msg.items.length;
        text = `Search complete — ${n} unique result${n === 1 ? "" : "s"}.`;
      }
      ui.progressText.textContent = text;
      // Auto-select the new run in the history dropdown so the user lands
      // directly on the results.
      if (msg.runId && !msg.cancelled) {
        selectedRunId = msg.runId;
        // Storage.onChanged will refresh runsCache and call renderRunDropdown,
        // which will respect the selectedRunId we just set.
      }
      // Hide the active progress panel and show the run-results area.
      show("input"); // back to input so they can see history below
      // Scroll the history section into view.
      document.querySelector("#history-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});

ui.searchClearBtn?.addEventListener("click", () => {
  if (ui.queryText) ui.queryText.value = "";
  showQueryError("");
});

ui.fetchBtn.addEventListener("click", async () => {
  const items = parseIdentifiers(ui.doisField.value);
  if (!items.length) {
    alert("No identifiers found. Paste DOIs (10.1038/nature12373), arXiv IDs (arXiv:2103.00020), or OpenReview IDs (openreview.net/forum?id=...).");
    return;
  }
  show("progress");
  ui.resultsList.innerHTML = "";
  for (const k of ["statPmc", "statOa", "statInst", "statTdm", "statCached", "statFail"]) ui[k].textContent = "0";

  // Sanitize and persist subfolder.
  const subfolder = (ui.subfolderField.value || "icompletist")
    .replace(/^[/\\]+|[/\\]+$/g, "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_");
  chrome.storage.local.set({ subfolder });

  const port = chrome.runtime.connect({ name: "fetch-job" });
  port.postMessage({ type: "start", items, subfolder });

  port.onMessage.addListener((msg) => {
    if (msg.type === "progress") {
      ui.progressFill.style.width = `${(msg.done / msg.total) * 100}%`;
      ui.progressText.textContent = `${msg.done} / ${msg.total} — ${msg.currentDoi || ""}`;
    } else if (msg.type === "result") {
      const r = msg.result;
      const counter = { pmc: "statPmc", oa: "statOa", institutional: "statInst", tdm: "statTdm", cached: "statCached", unavailable: "statFail" }[r.source];
      if (counter) ui[counter].textContent = String(parseInt(ui[counter].textContent, 10) + 1);

      const li = document.createElement("li");
      const sourceClass = r.source === "unavailable" ? "fail"
        : r.source === "institutional" ? "inst"
        : r.source;
      const tryUrlsHtml = Array.isArray(r.tryUrls) && r.tryUrls.length
        ? `<div class="try-urls">Try manually: ${r.tryUrls.map(
            (u) => `<a href="${u.url}" target="_blank" rel="noopener noreferrer" title="${u.label}">${u.label}</a>`
          ).join(" · ")}</div>`
        : "";
      li.innerHTML = `<div class="row-main"><span class="doi">${r.doi}</span><span class="source ${sourceClass}">${r.source}</span></div>${tryUrlsHtml}`;
      ui.resultsList.appendChild(li);
    } else if (msg.type === "done") {
      show("results");
      ui.progressText.textContent = `Finished: ${msg.summary.pmc || 0} PMC, ${msg.summary.oa || 0} OA, ${msg.summary.institutional || 0} institutional, ${msg.summary.tdm || 0} TDM, ${msg.summary.cached || 0} cached, ${msg.summary.unavailable || 0} unavailable.`;
    } else if (msg.type === "error") {
      ui.progressText.textContent = `Error: ${msg.error}`;
    }
  });

  ui.cancelBtn.onclick = () => { port.postMessage({ type: "cancel" }); show("input"); };
});

ui.clearBtn.addEventListener("click", () => { ui.doisField.value = ""; });
ui.resetBtn.addEventListener("click", () => { show("input"); ui.doisField.value = ""; });
ui.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// Only present in popup mode — in tab mode, this button doesn't exist.
const openTabBtn = document.getElementById("open-tab-btn");
if (openTabBtn) {
  openTabBtn.addEventListener("click", async () => {
    // Carry over the current textarea + subfolder values so the user doesn't
    // lose what they've typed when switching modes.
    await chrome.storage.local.set({
      pendingDois: ui.doisField.value,
      subfolder: ui.subfolderField.value,
    });
    await chrome.tabs.create({ url: chrome.runtime.getURL("tab.html") });
    window.close();
  });
}

// On load (popup OR tab), restore any pending DOIs handed off from the other mode.
chrome.storage.local.get({ pendingDois: "" }, ({ pendingDois }) => {
  if (pendingDois) {
    ui.doisField.value = pendingDois;
    chrome.storage.local.remove("pendingDois");
  }
});

// ---- Runs history ----

let runsCache = [];
let selectedRunId = null;

function fmtTs(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sourceClassFor(source) {
  return source === "unavailable" ? "fail"
    : source === "institutional" ? "inst"
    : source;
}

function runLabel(run) {
  const ts = fmtTs(run.startedAt);
  const status = run.finishedAt ? "" : " (running…)";
  if (run.kind === "search") {
    const s = run.summary || {};
    if (typeof s.searchCount === "number" && typeof s.ensureCount === "number" && s.searchCount !== s.ensureCount) {
      return `[SEARCH] ${ts} · ${s.searchCount} found → ${s.ensureCount} ensure-passed${status}`;
    }
    const total = s.total ?? run.results.length;
    return `[SEARCH] ${ts} · ${total} unique result${total === 1 ? "" : "s"}${status}`;
  }
  const summary = run.summary
    ? ` · ${run.summary.pmc || 0}+${run.summary.oa || 0}+${run.summary.tdm || 0}+${run.summary.institutional || 0}+${run.summary.cached || 0} ok, ${run.summary.unavailable || 0} fail`
    : ` · ${run.results.length}/${run.total}`;
  return `${ts} · ${run.total} DOIs${summary}${status}`;
}

function renderRunDropdown() {
  ui.historyCount.textContent = runsCache.length;

  // Newest first.
  const sorted = runsCache.slice().reverse();

  ui.runSelect.innerHTML = sorted.length
    ? sorted.map((r) => `<option value="${r.id}" ${r.id === selectedRunId ? "selected" : ""}>${runLabel(r)}</option>`).join("")
    : `<option value="">No runs yet — fetch some DOIs to see them here.</option>`;

  // Auto-select newest if nothing chosen.
  if (sorted.length && !sorted.find((r) => r.id === selectedRunId)) {
    selectedRunId = sorted[0].id;
    ui.runSelect.value = String(selectedRunId);
  }

  renderRunResults();
}

function renderRunResults() {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run) {
    ui.runResults.innerHTML = `<li class="empty">Select a run to see its results.</li>`;
    ui.runActions.hidden = true;
    return;
  }
  if (!run.results.length) {
    ui.runResults.innerHTML = `<li class="empty">This run has no results yet.</li>`;
    ui.runActions.hidden = true;
    return;
  }

  if (run.kind === "search") {
    // Rich rendering for search results.
    ui.runResults.innerHTML = run.results.map((e) => {
      const ident = e.identifiers || {};
      const idLabel = ident.doi || (ident.arxivId ? `arXiv:${ident.arxivId}` : "")
        || (ident.pmid ? `PMID:${ident.pmid}` : "") || e.doi || "(no identifier)";
      const sources = Array.isArray(e.sources) && e.sources.length
        ? `<span class="run-kind">${e.sources.join("+")}</span>`
        : "";
      const meta = [e.year, e.journal].filter(Boolean).join(" · ");
      return `
        <li data-doi="${ident.doi || ""}" title="${(e.abstract || e.title || "").replace(/"/g, "&quot;").slice(0, 300)}">
          <div class="row-main">
            <span class="doi">${(e.title || idLabel).slice(0, 120)}</span>
            ${sources}
          </div>
          ${meta ? `<div class="try-urls">${meta} — <span style="font-family: 'SF Mono', monospace;">${idLabel}</span></div>` : ""}
        </li>
      `;
    }).join("");
  } else {
    // Original rendering for fetch runs.
    ui.runResults.innerHTML = run.results.map((e) => {
      const tryUrlsHtml = Array.isArray(e.tryUrls) && e.tryUrls.length
        ? `<div class="try-urls">Try manually: ${e.tryUrls.map(
            (u) => `<a href="${u.url}" target="_blank" rel="noopener noreferrer" title="${u.label}">${u.label}</a>`
          ).join(" · ")}</div>`
        : "";
      return `
        <li data-doi="${e.doi}" title="${(e.filename || e.error || "Click to copy DOI to textarea").replace(/"/g, "&quot;")}">
          <div class="row-main">
            <span class="doi">${e.doi}</span>
            <span class="source ${sourceClassFor(e.source)}">${e.source}</span>
          </div>
          ${tryUrlsHtml}
        </li>
      `;
    }).join("");
  }

  ui.runActions.hidden = false;
  // Only show the "Download PDFs for this batch" button on search runs.
  if (ui.downloadPdfsBtn) ui.downloadPdfsBtn.hidden = run.kind !== "search";
}

ui.runSelect.addEventListener("change", (e) => {
  selectedRunId = Number(e.target.value) || null;
  renderRunResults();
});

// Click an individual result to add its DOI to the textarea.
ui.runResults.addEventListener("click", (e) => {
  const li = e.target.closest("li[data-doi]");
  if (!li) return;
  const doi = li.dataset.doi;
  const current = ui.doisField.value.trim();
  // Don't duplicate if it's already in the textarea.
  const existing = current.split(/[\s,;]+/).map((s) => s.toLowerCase());
  if (existing.includes(doi.toLowerCase())) return;
  ui.doisField.value = current ? `${current}\n${doi}` : doi;
});

ui.refillBtn.addEventListener("click", () => {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run) return;
  const dois = run.results.map((r) => r.doi).join("\n");
  ui.doisField.value = dois;
  show("input");
});

// "Download PDFs for this batch" — only shown for search-kind runs.
// Extracts the best identifier from each result and feeds it into the
// existing v1 fetch pipeline.
ui.downloadPdfsBtn?.addEventListener("click", () => {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run || run.kind !== "search" || !run.results.length) return;

  // Build identifier items in the shape the fetch pipeline expects.
  const items = [];
  for (const r of run.results) {
    const id = r.identifiers || {};
    if (id.doi) {
      items.push({ type: "doi", value: id.doi, original: id.doi });
    } else if (id.arxivId) {
      items.push({ type: "arxiv", value: id.arxivId, original: `arXiv:${id.arxivId}` });
    } else if (id.pmid) {
      // PMID alone won't resolve in the fetch pipeline, but the converter step
      // inside the PMC module can handle it via DOI. Skip if no DOI.
    }
  }

  if (!items.length) {
    alert("No DOIs or arXiv IDs available in this search run to download.");
    return;
  }

  if (!confirm(`Start downloading PDFs for ${items.length} of ${run.results.length} search results?`)) return;

  // Same flow as fetchBtn — show progress section, restore standard stats panel.
  show("progress");
  ui.resultsList.innerHTML = "";
  for (const k of ["statPmc", "statOa", "statInst", "statTdm", "statCached", "statFail"]) ui[k].textContent = "0";
  // Restore the standard stats panel (the search panel may have replaced it).
  const statsEl = document.querySelector("#progress-section .stats");
  if (statsEl) {
    statsEl.classList.remove("search-progress");
    statsEl.innerHTML = `
      <span class="stat pmc">PMC: <b id="stat-pmc">0</b></span>
      <span class="stat oa">OA: <b id="stat-oa">0</b></span>
      <span class="stat inst">Institutional: <b id="stat-inst">0</b></span>
      <span class="stat tdm">TDM API: <b id="stat-tdm">0</b></span>
      <span class="stat fail">Unavailable: <b id="stat-fail">0</b></span>
    `;
    // Re-bind the new stat elements.
    ui.statPmc = $("stat-pmc");
    ui.statOa = $("stat-oa");
    ui.statInst = $("stat-inst");
    ui.statTdm = $("stat-tdm");
    ui.statFail = $("stat-fail");
  }

  const subfolder = (ui.subfolderField.value || "icompletist")
    .replace(/^[/\\]+|[/\\]+$/g, "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_");
  chrome.storage.local.set({ subfolder });

  const port = chrome.runtime.connect({ name: "fetch-job" });
  port.postMessage({ type: "start", items, subfolder });

  port.onMessage.addListener((msg) => {
    if (msg.type === "progress") {
      ui.progressFill.style.width = `${(msg.done / msg.total) * 100}%`;
      ui.progressText.textContent = `${msg.done} / ${msg.total} — ${msg.currentDoi || ""}`;
    } else if (msg.type === "result") {
      const r = msg.result;
      const counter = { pmc: "statPmc", oa: "statOa", institutional: "statInst", tdm: "statTdm", cached: "statCached", unavailable: "statFail" }[r.source];
      if (counter) ui[counter].textContent = String(parseInt(ui[counter].textContent, 10) + 1);
      const li = document.createElement("li");
      const sourceClass = r.source === "unavailable" ? "fail"
        : r.source === "institutional" ? "inst"
        : r.source;
      const tryUrlsHtml = Array.isArray(r.tryUrls) && r.tryUrls.length
        ? `<div class="try-urls">Try manually: ${r.tryUrls.map(
            (u) => `<a href="${u.url}" target="_blank" rel="noopener noreferrer" title="${u.label}">${u.label}</a>`
          ).join(" · ")}</div>`
        : "";
      li.innerHTML = `<div class="row-main"><span class="doi">${r.doi}</span><span class="source ${sourceClass}">${r.source}</span></div>${tryUrlsHtml}`;
      ui.resultsList.appendChild(li);
    } else if (msg.type === "done") {
      show("results");
      ui.progressText.textContent = `Finished: ${msg.summary.pmc || 0} PMC, ${msg.summary.oa || 0} OA, ${msg.summary.institutional || 0} institutional, ${msg.summary.tdm || 0} TDM, ${msg.summary.cached || 0} cached, ${msg.summary.unavailable || 0} unavailable.`;
    }
  });
});

ui.exportRunBtn.addEventListener("click", async () => {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run || !run.results.length) return;

  const { downloadsPath = "" } = await new Promise((resolve) =>
    chrome.storage.sync.get({ downloadsPath: "" }, resolve)
  );

  const ris = buildRis(run, { downloadsPath });
  const dataUrl = `data:application/x-research-info-systems;charset=utf-8,${encodeURIComponent(ris)}`;
  const stamp = new Date(run.startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  chrome.downloads.download({
    url: dataUrl,
    filename: `icompletist-run-${stamp}.ris`,
    saveAs: false,
  });
});

ui.historyClear.addEventListener("click", async () => {
  if (!runsCache.length) return;
  const ok = confirm(`Clear all ${runsCache.length} runs from history? This cannot be undone.`);
  if (!ok) return;
  await chrome.storage.local.set({ runs: [] });
  runsCache = [];
  selectedRunId = null;
  renderRunDropdown();
});

async function loadRuns() {
  const { runs = [] } = await chrome.storage.local.get({ runs: [] });
  runsCache = runs;
  renderRunDropdown();
}

// Live-refresh when background updates the runs.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.runs) {
    runsCache = changes.runs.newValue || [];
    // Keep current selection if it still exists; otherwise jump to newest.
    if (selectedRunId && !runsCache.find((r) => r.id === selectedRunId)) {
      selectedRunId = null;
    }
    renderRunDropdown();
  }
});

loadRuns();

show("input");
