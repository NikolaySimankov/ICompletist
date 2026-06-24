// popup.js - UI controller
import { parseIdentifiers } from "./lib/identifiers.js";
import { buildRis } from "./lib/risexport.js";
import { buildSpec, QueryParseError } from "./lib/search/spec.js";
import { isPdfBlob } from "./lib/pdfcheck.js";
import { updateRunResult, removeRunResult, removeUnavailableResults } from "./lib/history.js";
import { commonNamesFromWikidata } from "./lib/wikidata.js";

const $ = (id) => document.getElementById(id);

const ui = {
  input: $("input-section"),
  progress: $("progress-section"),
  results: $("results-section"),
  doisField: $("dois"),
  subfolderField: $("subfolder"),
  downloadMode: $("download-mode"),
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
  resumeBtn: $("resume-btn"),
  recoverQueryBtn: $("recover-query-btn"),
  deleteRunBtn: $("delete-run-btn"),
  removeUnavailableBtn: $("remove-unavailable-btn"),
  // Search-mode bindings:
  modeIdBtn: $("mode-id-btn"),
  modeSearchBtn: $("mode-search-btn"),
  modeConvertBtn: $("mode-convert-btn"),
  idPanel: $("id-panel"),
  searchPanel: $("search-panel"),
  convertPanel: $("convert-panel"),
  downloadModeGroup: $("download-mode-group"),
  pdfFiles: $("pdf-files"),
  convertBtn: $("convert-btn"),
  convertClearBtn: $("convert-clear-btn"),
  convertResults: $("convert-results"),
  queryText: $("query-text"),
  queryError: $("query-error"),
  yearFrom: $("year-from"),
  yearTo: $("year-to"),
  fieldSelect: $("field-select"),
  limitInput: $("limit-input"),
  searchBtn: $("search-btn"),
  searchClearBtn: $("search-clear-btn"),
  prequeryInput: $("prequery-input"),
  prequeryBtn: $("prequery-btn"),
  prequeryStatus: $("prequery-status"),
  prequeryResults: $("prequery-results"),
};

// Restore last-used subfolder on open.
chrome.storage.local.get({ subfolder: "icompletist" }, ({ subfolder }) => {
  ui.subfolderField.value = subfolder;
});

// Restore + persist the download mode (PDF / TXT / both).
chrome.storage.local.get({ downloadMode: "pdf" }, ({ downloadMode }) => {
  if (ui.downloadMode) ui.downloadMode.value = downloadMode;
});
ui.downloadMode?.addEventListener("change", () => {
  chrome.storage.local.set({ downloadMode: ui.downloadMode.value });
});
function getDownloadMode() {
  return ui.downloadMode?.value || "pdf";
}

// ---- Theme (light / dark / auto) ----
// "auto" follows the OS (no data-theme attribute → the prefers-color-scheme
// media query in popup.css decides). "light"/"dark" force the theme via a
// data-theme attribute on <html>. Choice persists in chrome.storage.local
// and is shared by popup + tab (both load this file).
const THEME_ORDER = ["auto", "light", "dark"];
const THEME_ICON = { auto: "◐", light: "☀", dark: "☾" };
let _theme = "auto";
function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  const btn = document.getElementById("theme-btn");
  if (btn) {
    btn.textContent = THEME_ICON[mode] || "◐";
    btn.title = `Theme: ${mode} — click to change`;
  }
}
chrome.storage.local.get({ theme: "auto" }, ({ theme }) => {
  _theme = THEME_ORDER.includes(theme) ? theme : "auto";
  applyTheme(_theme);
});
document.getElementById("theme-btn")?.addEventListener("click", () => {
  _theme = THEME_ORDER[(THEME_ORDER.indexOf(_theme) + 1) % THEME_ORDER.length];
  chrome.storage.local.set({ theme: _theme });
  applyTheme(_theme);
});

// ---- Service-worker keepalive ----
// Chrome MV3 service workers are killed after 5 minutes of no browser
// events. A 2500-DOI batch takes far longer than that. We ping the service
// worker every 25 seconds while a job is running so Chrome keeps resetting
// the idle timer and never terminates the worker mid-batch.
let _keepaliveTimer = null;
function startKeepalive() {
  if (_keepaliveTimer) return; // already running
  _keepaliveTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: "keepalive" }).catch(() => {});
  }, 25_000);
}
function stopKeepalive() {
  clearInterval(_keepaliveTimer);
  _keepaliveTimer = null;
}

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
  ui.modeConvertBtn?.classList.toggle("active", mode === "convert");
  if (ui.idPanel) ui.idPanel.hidden = mode !== "id";
  if (ui.searchPanel) ui.searchPanel.hidden = mode !== "search";
  if (ui.convertPanel) ui.convertPanel.hidden = mode !== "convert";
  // The PDF/TXT/both download selector only applies to fetch/search downloads,
  // not the standalone PDF→TXT converter.
  if (ui.downloadModeGroup) ui.downloadModeGroup.hidden = mode === "convert";
  chrome.storage.local.set({ mode });
}

ui.modeIdBtn?.addEventListener("click", () => setMode("id"));
ui.modeSearchBtn?.addEventListener("click", () => setMode("search"));
ui.modeConvertBtn?.addEventListener("click", () => setMode("convert"));

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
  const ensure = document.getElementById("ensure-cb")?.checked ?? true;
  return { queryText, yearFrom, yearTo, field, doctype, sources, limit, ensure };
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
  port.postMessage({ type: "start", spec, sources: inputs.sources, limit: inputs.limit, ensure: inputs.ensure });

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
        ui.progressText.textContent = `Enriching metadata for ${msg.before} item${msg.before === 1 ? "" : "s"} (Crossref)…`;
      } else if (msg.stage === "ensure") {
        if (msg.skipped) {
          ui.progressText.textContent = `ENSURE skipped — keeping all ${msg.after} results.`;
        } else {
          const dropped = msg.before - msg.after;
          ui.progressText.textContent = `ENSURE filter: ${msg.before} → ${msg.after} (dropped ${dropped}).`;
        }
      }
    } else if (msg.type === "enrich-progress") {
      if (msg.total) ui.progressText.textContent = `Enriching metadata… ${msg.done}/${msg.total} (Crossref)`;
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

// ---- PDF → TXT converter (no history; one-off conversions) ----

function sanitizeSubfolder(value) {
  return (value || "icompletist")
    .replace(/^[/\\]+|[/\\]+$/g, "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_");
}

function txtNameFor(pdfFileName) {
  // Keep the original base name, just drop .pdf and strip path-illegal chars.
  return pdfFileName.replace(/\.pdf$/i, "").replace(/[<>:"|?*\x00-\x1f/\\]/g, "_");
}

async function fileToBase64(file) {
  const dataUrl = await blobToDataUrl(file);
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

ui.convertClearBtn?.addEventListener("click", () => {
  if (ui.pdfFiles) ui.pdfFiles.value = "";
  if (ui.convertResults) ui.convertResults.innerHTML = "";
});

ui.convertBtn?.addEventListener("click", async () => {
  const files = [...(ui.pdfFiles?.files || [])];
  if (!files.length) { alert("Choose one or more PDF files to convert."); return; }

  const subfolder = sanitizeSubfolder(ui.subfolderField.value);
  chrome.storage.local.set({ subfolder });
  ui.convertResults.innerHTML = "";

  ui.convertBtn.disabled = true;
  try {
    for (const file of files) {
      const base = txtNameFor(file.name);
      const li = document.createElement("li");
      li.className = "convert-row";
      const nameEl = document.createElement("span");
      nameEl.className = "conv-name";
      nameEl.textContent = `${base}.txt`;
      const statusEl = document.createElement("span");
      statusEl.className = "conv-status";
      statusEl.textContent = "converting…";
      li.append(nameEl, statusEl);
      ui.convertResults.appendChild(li);

      try {
        const dataBase64 = await fileToBase64(file);
        const resp = await chrome.runtime.sendMessage({ type: "pdf-to-text", dataBase64 });
        if (!resp || !resp.ok) throw new Error(resp?.error || "extraction failed");
        const text = resp.text || "";
        const url = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
        await chrome.downloads.download({
          url,
          filename: `${subfolder}/${base}.txt`,
          saveAs: false,
          conflictAction: "uniquify",
        });
        statusEl.textContent = `saved · ${text.length.toLocaleString()} chars`;
        statusEl.className = "conv-status ok";
      } catch (e) {
        statusEl.textContent = `failed: ${e.message}`;
        statusEl.className = "conv-status err";
      }
    }
  } finally {
    ui.convertBtn.disabled = false;
  }
});

// ---- Prequery: Wikidata common-name expansion ----
const _esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

ui.prequeryBtn?.addEventListener("click", async () => {
  const term = (ui.prequeryInput?.value || "").trim();
  if (!term) return;
  ui.prequeryResults.hidden = true;
  ui.prequeryResults.innerHTML = "";
  ui.prequeryStatus.hidden = false;
  ui.prequeryStatus.className = "prequery-status";
  ui.prequeryStatus.textContent = "Searching Wikidata…";

  let names = [];
  try {
    const { email } = await new Promise((r) => chrome.storage.sync.get({ email: "" }, r));
    names = await commonNamesFromWikidata(term, email);
  } catch (e) {
    ui.prequeryStatus.className = "prequery-status err";
    ui.prequeryStatus.textContent = `Wikidata lookup failed: ${e.message}`;
    return;
  }

  // Always offer the original term plus the discovered names.
  const all = [];
  const seen = new Set();
  for (const n of [term, ...names]) {
    const key = n.toLowerCase();
    if (!seen.has(key)) { seen.add(key); all.push(n); }
  }
  if (all.length <= 1) {
    ui.prequeryStatus.className = "prequery-status";
    ui.prequeryStatus.textContent = `No common names found for “${term}”.`;
    return;
  }

  ui.prequeryStatus.hidden = true;
  ui.prequeryResults.hidden = false;
  ui.prequeryResults.innerHTML = `
    <div class="prequery-hint">${all.length} terms — untick any you don't want, then add:</div>
    <div class="prequery-chips">
      ${all.map((n) => `<label class="chip"><input type="checkbox" checked data-term="${_esc(n)}"> ${_esc(n)}</label>`).join("")}
    </div>
    <button class="prequery-add">Add as OR group to query</button>
  `;
});

ui.prequeryResults?.addEventListener("click", (e) => {
  if (!e.target.closest(".prequery-add")) return;
  const checked = [...ui.prequeryResults.querySelectorAll(".chip input:checked")].map((cb) => cb.dataset.term);
  if (!checked.length) return;
  const group = checked.map((t) => `"${t}"`).join(" OR ");
  const cur = (ui.queryText.value || "").replace(/\s+$/, "");
  // First group has no operator; later groups are AND-joined (synonyms narrow
  // an existing query). The user can edit the operator afterward.
  ui.queryText.value = cur ? `${cur}\nAND ${group}` : group;
  ui.prequeryResults.hidden = true;
  ui.prequeryResults.innerHTML = "";
  if (ui.prequeryInput) ui.prequeryInput.value = "";
  ui.queryText.focus();
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
  startKeepalive();
  port.postMessage({ type: "start", items, subfolder, downloadMode: getDownloadMode() });

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
      stopKeepalive();
      show("results");
      ui.progressText.textContent = `Finished: ${msg.summary.pmc || 0} PMC, ${msg.summary.oa || 0} OA, ${msg.summary.institutional || 0} institutional, ${msg.summary.tdm || 0} TDM, ${msg.summary.cached || 0} cached, ${msg.summary.unavailable || 0} unavailable.`;
    } else if (msg.type === "error") {
      stopKeepalive();
      ui.progressText.textContent = `Error: ${msg.error}`;
    }
  });

  ui.cancelBtn.onclick = () => { stopKeepalive(); port.postMessage({ type: "cancel" }); show("input"); };
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
    ? ` · ${run.summary.pmc || 0}+${run.summary.oa || 0}+${run.summary.tdm || 0}+${run.summary.institutional || 0}+${run.summary.cached || 0}+${run.summary.manual || 0} ok, ${run.summary.unavailable || 0} fail`
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
    // No results yet — but still surface Resume/Delete for interrupted runs.
    ui.runResults.innerHTML = `<li class="empty">This run has no results yet.</li>`;
    setRunActionVisibility(run);
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
    ui.runResults.innerHTML = run.results.map((e, idx) => {
      const tryUrlsHtml = Array.isArray(e.tryUrls) && e.tryUrls.length
        ? `<div class="try-urls">Try manually: ${e.tryUrls.map(
            (u) => `<a href="${u.url}" target="_blank" rel="noopener noreferrer" title="${u.label}">${u.label}</a>`
          ).join(" · ")}</div>`
        : "";
      // Guided manual-attach panel for items with no PDF on disk yet.
      const attachHtml = !e.filename ? `
        <div class="attach-area">
          <div class="attach-panel" data-idx="${idx}">
            <div class="attach-hint">Open a link above to find the PDF, then:</div>
            <label class="attach-file-btn">Choose downloaded PDF…
              <input type="file" accept="application/pdf" class="attach-file-input" data-idx="${idx}" hidden>
            </label>
            <div class="attach-or">or paste a direct PDF URL</div>
            <div class="attach-url-row">
              <input type="url" class="attach-url-input" data-idx="${idx}" placeholder="https://…/article.pdf">
              <button class="attach-url-go" data-idx="${idx}">Fetch</button>
            </div>
            <div class="attach-status" data-idx="${idx}"></div>
          </div>
        </div>` : "";
      const delBtn = e.source === "unavailable"
        ? `<button class="del-result" data-idx="${idx}" title="Remove this item from the run">✕</button>`
        : "";
      return `
        <li data-doi="${e.doi}" title="${(e.filename || e.error || "Click to copy DOI to textarea").replace(/"/g, "&quot;")}">
          <div class="row-main">
            <span class="doi">${e.doi}</span>
            <span class="source ${sourceClassFor(e.source)}">${e.source}</span>
            ${delBtn}
          </div>
          ${tryUrlsHtml}
          ${attachHtml}
        </li>
      `;
    }).join("");
  }

  setRunActionVisibility(run);
}

// Decide which run-action buttons apply to the selected run.
function setRunActionVisibility(run) {
  ui.runActions.hidden = false;
  const isSearch = run.kind === "search";
  const incomplete = !run.finishedAt;
  const hasResults = run.results.length > 0;
  if (ui.downloadPdfsBtn) ui.downloadPdfsBtn.hidden = !isSearch || !hasResults;
  // Recover the query: search runs that stored their spec.
  if (ui.recoverQueryBtn) ui.recoverQueryBtn.hidden = !(isSearch && run.spec);
  // Resume: fetch runs that never finished and still have their input items.
  if (ui.resumeBtn) {
    ui.resumeBtn.hidden = !(incomplete && !isSearch && Array.isArray(run.items) && run.items.length);
  }
  // Refill / export only make sense once there are results.
  if (ui.refillBtn) ui.refillBtn.hidden = !hasResults;
  if (ui.exportRunBtn) ui.exportRunBtn.hidden = !hasResults;
  // "Remove all unavailable" only when the run actually has failed items.
  if (ui.removeUnavailableBtn) {
    ui.removeUnavailableBtn.hidden = !run.results.some((r) => r.source === "unavailable");
  }
  // Delete is always available (default-visible).
}

ui.runSelect.addEventListener("change", (e) => {
  selectedRunId = Number(e.target.value) || null;
  renderRunResults();
});

// Click an individual result to add its DOI to the textarea.
ui.runResults.addEventListener("click", (e) => {
  // Clicks inside the manual-attach panel / on the delete button are handled
  // by their own listeners.
  if (e.target.closest(".attach-area") || e.target.closest(".del-result")) return;
  const li = e.target.closest("li[data-doi]");
  if (!li) return;
  const doi = li.dataset.doi;
  const current = ui.doisField.value.trim();
  // Don't duplicate if it's already in the textarea.
  const existing = current.split(/[\s,;]+/).map((s) => s.toLowerCase());
  if (existing.includes(doi.toLowerCase())) return;
  ui.doisField.value = current ? `${current}\n${doi}` : doi;
});

// ---- Guided manual attach ----
// Lets the user file a manually-obtained PDF (picked from disk, or fetched
// from a direct URL) under ICompletist's naming convention into the run's
// subfolder, flipping the result from "unavailable" to "manual".

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Reproduce background.downloadBlob's naming so a manual file lands exactly
// where the automated path would have put it.
function manualFilename(doi, subfolder) {
  const safe = doi.replace(/[^a-z0-9]+/gi, "_");
  const folder = (subfolder || "icompletist")
    .replace(/^[/\\]+|[/\\]+$/g, "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_");
  return `${folder}/${safe}.pdf`;
}

function setAttachStatus(idx, msg, kind) {
  const el = ui.runResults.querySelector(`.attach-status[data-idx="${idx}"]`);
  if (!el) return;
  el.className = `attach-status${kind ? ` ${kind}` : ""}`;
  el.textContent = msg;
}

async function attachFile(idx, file) {
  const run = runsCache.find((r) => r.id === selectedRunId);
  const e = run?.results?.[idx];
  if (!run || !e) return;
  if (!(await isPdfBlob(file))) { setAttachStatus(idx, "That file isn't a PDF.", "err"); return; }
  setAttachStatus(idx, "Saving…");
  const subfolder = run.subfolder || ui.subfolderField.value || "icompletist";
  try {
    const dataUrl = await blobToDataUrl(file);
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: manualFilename(e.doi, subfolder),
      saveAs: false,
      conflictAction: "uniquify",
    });
    // Capture the real absolute path so RIS export gets a working file:// link.
    let stored = manualFilename(e.doi, subfolder);
    try {
      const items = await chrome.downloads.search({ id: downloadId });
      if (items && items[0] && items[0].filename) stored = items[0].filename;
    } catch { /* fall back to relative */ }
    await updateRunResult(run.id, e.doi, {
      source: "manual", filename: stored, via: "manual-file", error: null, tryUrls: null,
    });
    setAttachStatus(idx, "Saved ✓", "ok");
    // storage.onChanged re-renders the run.
  } catch (err) {
    setAttachStatus(idx, err.message || "Save failed", "err");
  }
}

function attachUrl(idx) {
  const run = runsCache.find((r) => r.id === selectedRunId);
  const e = run?.results?.[idx];
  if (!run || !e) return;
  const input = ui.runResults.querySelector(`.attach-url-input[data-idx="${idx}"]`);
  const url = (input?.value || "").trim();
  if (!url) { setAttachStatus(idx, "Enter a URL.", "err"); return; }
  setAttachStatus(idx, "Fetching…");
  const subfolder = run.subfolder || ui.subfolderField.value || "icompletist";
  chrome.runtime.sendMessage(
    { type: "manual-url", runId: run.id, doi: e.doi, subfolder, url },
    (resp) => {
      if (chrome.runtime.lastError) { setAttachStatus(idx, chrome.runtime.lastError.message, "err"); return; }
      if (resp?.ok) setAttachStatus(idx, "Saved ✓", "ok");
      else setAttachStatus(idx, resp?.error || "Failed", "err");
    }
  );
}

ui.runResults.addEventListener("click", (e) => {
  const go = e.target.closest(".attach-url-go");
  if (go) { attachUrl(parseInt(go.dataset.idx, 10)); return; }
  // Remove a single unavailable item from the run (updates RIS).
  const del = e.target.closest(".del-result");
  if (del) {
    const run = runsCache.find((r) => r.id === selectedRunId);
    const res = run?.results?.[parseInt(del.dataset.idx, 10)];
    if (run && res) removeRunResult(run.id, res.doi); // storage.onChanged re-renders
  }
});

// "Remove all unavailable" — drop every failed item from the selected run.
ui.removeUnavailableBtn?.addEventListener("click", async () => {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run) return;
  const n = run.results.filter((r) => r.source === "unavailable").length;
  if (!n) return;
  if (!confirm(`Remove all ${n} unavailable item${n === 1 ? "" : "s"} from this run? This updates the RIS export.`)) return;
  await removeUnavailableResults(run.id); // storage.onChanged re-renders
});

ui.runResults.addEventListener("change", (e) => {
  const fi = e.target.closest(".attach-file-input");
  if (fi && fi.files && fi.files[0]) attachFile(parseInt(fi.dataset.idx, 10), fi.files[0]);
});

ui.refillBtn.addEventListener("click", () => {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run) return;
  const dois = run.results.map((r) => r.doi).join("\n");
  ui.doisField.value = dois;
  show("input");
});

// ---- Delete a single run ----
ui.deleteRunBtn?.addEventListener("click", async () => {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run) return;
  if (!confirm("Delete this run from history? This cannot be undone.")) return;
  const remaining = runsCache.filter((r) => r.id !== selectedRunId);
  await chrome.storage.local.set({ runs: remaining });
  runsCache = remaining;
  selectedRunId = null;
  renderRunDropdown();
});

// ---- Recover the query from a search run ----
// Rebuild the line-per-group query text + all the search controls from the
// stored spec so the user can tweak and re-run.
function reconstructQueryText(spec) {
  const q = (t) => (/\s/.test(t) ? `"${t}"` : t);
  return (spec.groups || []).map((g, i) => {
    const inner = g.terms.map(q).join(` ${g.internal || "OR"} `);
    return i === 0 ? inner : `${g.external || "AND"} ${inner}`;
  }).join("\n");
}

ui.recoverQueryBtn?.addEventListener("click", () => {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run || run.kind !== "search" || !run.spec) return;
  const spec = run.spec;
  setMode("search");
  if (ui.queryText) ui.queryText.value = reconstructQueryText(spec);
  if (ui.yearFrom) ui.yearFrom.value = spec.yearFrom || "";
  if (ui.yearTo) ui.yearTo.value = spec.yearTo || "";
  if (ui.fieldSelect && spec.field) ui.fieldSelect.value = spec.field;
  const doctype = new Set(spec.doctype && spec.doctype.length ? spec.doctype : ["article", "review"]);
  document.querySelectorAll(".doctype-cb").forEach((cb) => { cb.checked = doctype.has(cb.value); });
  const sources = new Set(run.sources || []);
  document.querySelectorAll(".source-cb").forEach((cb) => { cb.checked = sources.has(cb.value); });
  const ensureCb = document.getElementById("ensure-cb");
  if (ensureCb) ensureCb.checked = run.ensure !== false;
  showQueryError("");
  show("input");
  document.querySelector("#input-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// ---- Resume an interrupted fetch run ----
// Re-process only the items that never produced a result, appending into the
// same run so history stays coherent.
ui.resumeBtn?.addEventListener("click", () => {
  const run = runsCache.find((r) => r.id === selectedRunId);
  if (!run || run.kind === "search" || !Array.isArray(run.items)) return;

  const done = new Set(run.results.map((r) => r.original).filter(Boolean));
  const remaining = run.items.filter((it) => !done.has(it.original));
  if (!remaining.length) {
    alert("Nothing to resume — every item in this run already has a result.");
    return;
  }
  if (!confirm(`Resume this run? ${remaining.length} of ${run.items.length} item(s) still need processing.`)) return;

  show("progress");
  ui.resultsList.innerHTML = "";
  for (const k of ["statPmc", "statOa", "statInst", "statTdm", "statCached", "statFail"]) ui[k].textContent = "0";
  // Restore the standard stats panel in case search mode replaced it.
  const statsEl = document.querySelector("#progress-section .stats");
  if (statsEl) {
    statsEl.classList.remove("search-progress");
    statsEl.innerHTML = `
      <span class="stat pmc">PMC: <b id="stat-pmc">0</b></span>
      <span class="stat oa">OA: <b id="stat-oa">0</b></span>
      <span class="stat inst">Institutional: <b id="stat-inst">0</b></span>
      <span class="stat tdm">TDM API: <b id="stat-tdm">0</b></span>
      <span class="stat cached">Cached: <b id="stat-cached">0</b></span>
      <span class="stat fail">Unavailable: <b id="stat-fail">0</b></span>`;
    ui.statPmc = $("stat-pmc"); ui.statOa = $("stat-oa"); ui.statInst = $("stat-inst");
    ui.statTdm = $("stat-tdm"); ui.statCached = $("stat-cached"); ui.statFail = $("stat-fail");
  }

  const subfolder = run.subfolder || "icompletist";
  const port = chrome.runtime.connect({ name: "fetch-job" });
  startKeepalive();
  port.postMessage({ type: "start", items: remaining, subfolder, resumeRunId: run.id, downloadMode: getDownloadMode() });

  port.onMessage.addListener((msg) => {
    if (msg.type === "progress") {
      ui.progressFill.style.width = `${(msg.done / msg.total) * 100}%`;
      ui.progressText.textContent = `${msg.done} / ${msg.total} — ${msg.currentDoi || ""}`;
    } else if (msg.type === "result") {
      const r = msg.result;
      const counter = { pmc: "statPmc", oa: "statOa", institutional: "statInst", tdm: "statTdm", cached: "statCached", unavailable: "statFail" }[r.source];
      if (counter) ui[counter].textContent = String(parseInt(ui[counter].textContent, 10) + 1);
      const li = document.createElement("li");
      const sourceClass = r.source === "unavailable" ? "fail" : r.source === "institutional" ? "inst" : r.source;
      li.innerHTML = `<div class="row-main"><span class="doi">${r.doi}</span><span class="source ${sourceClass}">${r.source}</span></div>`;
      ui.resultsList.appendChild(li);
    } else if (msg.type === "done") {
      stopKeepalive();
      show("results");
      ui.progressText.textContent = `Finished: ${msg.summary.pmc || 0} PMC, ${msg.summary.oa || 0} OA, ${msg.summary.institutional || 0} institutional, ${msg.summary.tdm || 0} TDM, ${msg.summary.cached || 0} cached, ${msg.summary.unavailable || 0} unavailable.`;
    }
  });

  ui.cancelBtn.onclick = () => { stopKeepalive(); port.postMessage({ type: "cancel" }); show("input"); };
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
  startKeepalive();
  port.postMessage({ type: "start", items, subfolder, downloadMode: getDownloadMode() });

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
      stopKeepalive();
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
  // Save the RIS alongside the PDFs, in the same Downloads subfolder.
  const subfolder = (run.subfolder || ui.subfolderField.value || "icompletist")
    .replace(/^[/\\]+|[/\\]+$/g, "")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_");
  chrome.downloads.download({
    url: dataUrl,
    filename: `${subfolder}/icompletist-run-${stamp}.ris`,
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
