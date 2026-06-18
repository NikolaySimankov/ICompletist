// popup.js - UI controller
import { parseIdentifiers } from "./lib/identifiers.js";
import { buildRis } from "./lib/risexport.js";

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
  statFail: $("stat-fail"),
  historyCount: $("history-count"),
  historyClear: $("history-clear"),
  runSelect: $("run-select"),
  runResults: $("run-results"),
  runActions: $("run-actions"),
  refillBtn: $("refill-btn"),
  exportRunBtn: $("export-run-btn"),
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

ui.fetchBtn.addEventListener("click", async () => {
  const items = parseIdentifiers(ui.doisField.value);
  if (!items.length) {
    alert("No identifiers found. Paste DOIs (10.1038/nature12373), arXiv IDs (arXiv:2103.00020), or OpenReview IDs (openreview.net/forum?id=...).");
    return;
  }
  show("progress");
  ui.resultsList.innerHTML = "";
  for (const k of ["statPmc", "statOa", "statInst", "statTdm", "statFail"]) ui[k].textContent = "0";

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
      const counter = { pmc: "statPmc", oa: "statOa", institutional: "statInst", tdm: "statTdm", unavailable: "statFail" }[r.source];
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
      ui.progressText.textContent = `Finished: ${msg.summary.pmc || 0} PMC, ${msg.summary.oa || 0} OA, ${msg.summary.institutional || 0} institutional, ${msg.summary.tdm || 0} TDM, ${msg.summary.unavailable || 0} unavailable.`;
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
  const summary = run.summary
    ? ` · ${run.summary.pmc || 0}+${run.summary.oa || 0}+${run.summary.tdm || 0}+${run.summary.institutional || 0} ok, ${run.summary.unavailable || 0} fail`
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
  ui.runActions.hidden = false;
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
