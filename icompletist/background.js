// background.js - service worker orchestrating the fetch pipeline.
import { unpaywallLookup } from "./lib/unpaywall.js";
import { pmcLookup } from "./lib/pmc.js";
import { arxivFetch } from "./lib/arxiv.js";
import { biorxivFetch, isBiorxivDoi } from "./lib/biorxiv.js";
import { openreviewFetch } from "./lib/openreview.js";
import { ieeeOaFetch, isIeeeDoi } from "./lib/ieee.js";
import { elsevierTdmFetch } from "./lib/elsevier.js";
import { springerTdmFetch } from "./lib/springer.js";
import { wileyTdmFetch } from "./lib/wiley.js";
import { resolveOpenUrl, fetchWithSession } from "./lib/resolver.js";
import { startRun, appendToRun, finishRun } from "./lib/history.js";

// Throttle config: minimum gap between hits to the same publisher domain.
const PUBLISHER_DELAY_MS = 2000;
const lastHit = new Map();

async function throttle(domain) {
  const now = Date.now();
  const prev = lastHit.get(domain) || 0;
  const wait = Math.max(0, PUBLISHER_DELAY_MS - (now - prev));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(domain, Date.now());
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        email: "",
        ncbiApiKey: "",
        elsevierKey: "",
        elsevierInstToken: "",
        springerKey: "",
        wileyToken: "",
        ieeeKey: "",
        resolverBase: "",
      },
      resolve
    );
  });
}

function publisherFromDoi(doi) {
  const prefix = doi.split("/")[0];
  const map = {
    "10.1016": "elsevier",
    "10.1006": "elsevier",
    "10.1007": "springer",
    "10.1038": "springer",   // Nature is Springer Nature
    "10.1186": "springer",   // BMC
    "10.1002": "wiley",
    "10.1111": "wiley",
    "10.1101": "biorxiv",    // bioRxiv / medRxiv
    "10.1109": "ieee",
    "10.1126": "aaas",       // Science
    "10.1093": "oup",
    "10.1080": "taylor-francis",
  };
  return map[prefix] || "unknown";
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadBlob(blob, identifier, subfolder) {
  const url = await blobToDataUrl(blob);
  const safe = identifier.replace(/[^a-z0-9]+/gi, "_");
  const folder = (subfolder || "icompletist").replace(/[<>:"|?*\x00-\x1f]/g, "_");
  const filename = `${folder}/${safe}.pdf`;
  await chrome.downloads.download({
    url,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
  return filename;
}

// ---- Per-type handlers ----
// Each returns the same shape as the DOI pipeline:
//   { doi, source, filename, ... } on success, or
//   { doi, source: "unavailable", ... } on failure.

async function handleArxiv(item, settings, subfolder) {
  const display = `arxiv:${item.value}`;
  try {
    const r = await arxivFetch(item.value);
    if (r.found) {
      const filename = await downloadBlob(r.blob, display, subfolder);
      return { doi: display, source: "oa", arxivId: r.arxivId, filename };
    }
    return { doi: display, source: "unavailable", error: r.reason };
  } catch (e) {
    console.warn("arXiv error for", display, e);
    return { doi: display, source: "unavailable", error: e.message };
  }
}

async function handleOpenReview(item, settings, subfolder) {
  const display = `openreview:${item.value}`;
  try {
    const r = await openreviewFetch(item.value);
    if (r.found) {
      const filename = await downloadBlob(r.blob, display, subfolder);
      return { doi: display, source: "oa", openreviewId: item.value, filename };
    }
    return { doi: display, source: "unavailable", error: r.reason };
  } catch (e) {
    console.warn("OpenReview error for", display, e);
    return { doi: display, source: "unavailable", error: e.message };
  }
}

async function handleDoi(item, settings, subfolder) {
  const doi = item.value;
  const publisher = publisherFromDoi(doi);

  // Step 1: bioRxiv / medRxiv — fully OA, no key needed.
  if (isBiorxivDoi(doi)) {
    try {
      const r = await biorxivFetch(doi);
      if (r.found) {
        const filename = await downloadBlob(r.blob, doi, subfolder);
        return { doi, source: "oa", publisher: r.server, filename };
      }
    } catch (e) {
      console.warn("bioRxiv error for", doi, e);
    }
  }

  // Step 2: PMC.
  try {
    await throttle("ncbi");
    const pmc = await pmcLookup(doi, { email: settings.email, apiKey: settings.ncbiApiKey });
    if (pmc.found) {
      const filename = await downloadBlob(pmc.blob, doi, subfolder);
      return { doi, source: "pmc", pmcid: pmc.pmcid, filename };
    }
  } catch (e) {
    console.warn("PMC error for", doi, e);
  }

  // Step 3: Unpaywall.
  if (settings.email) {
    try {
      const up = await unpaywallLookup(doi, settings.email);
      if (up.found) {
        const pdfRes = await fetch(up.pdfUrl);
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          if (blob.type.includes("pdf") || blob.size > 10000) {
            const filename = await downloadBlob(blob, doi, subfolder);
            return { doi, source: "oa", title: up.title, license: up.license, filename };
          }
          console.warn("Unpaywall returned non-PDF for", doi, "type:", blob.type, "size:", blob.size);
        } else {
          console.warn("Unpaywall PDF fetch failed for", doi, "status:", pdfRes.status);
        }
      } else {
        console.info("Unpaywall: no OA copy for", doi);
      }
    } catch (e) {
      console.warn("Unpaywall error for", doi, e);
    }
  }

  // Step 4: IEEE Open Access API.
  if (isIeeeDoi(doi) && settings.ieeeKey) {
    try {
      await throttle("ieee");
      const r = await ieeeOaFetch(doi, { apiKey: settings.ieeeKey });
      if (r.found) {
        const filename = await downloadBlob(r.blob, doi, subfolder);
        return { doi, source: "oa", publisher: "ieee", filename };
      } else {
        console.info("IEEE OA: not available for", doi, r.reason);
      }
    } catch (e) {
      console.warn("IEEE error for", doi, e);
    }
  }

  // Step 5: Publisher-specific TDM APIs.
  if (publisher === "elsevier" && settings.elsevierKey) {
    await throttle("elsevier-tdm");
    const r = await elsevierTdmFetch(doi, {
      apiKey: settings.elsevierKey,
      instToken: settings.elsevierInstToken,
    });
    if (r.found) {
      const filename = await downloadBlob(r.blob, doi, subfolder);
      return { doi, source: "tdm", publisher, filename };
    }
  }
  if (publisher === "springer" && settings.springerKey) {
    await throttle("springer-tdm");
    const r = await springerTdmFetch(doi, { apiKey: settings.springerKey });
    if (r.found) {
      const filename = await downloadBlob(r.blob, doi, subfolder);
      return { doi, source: "tdm", publisher, filename };
    }
  }
  if (publisher === "wiley" && settings.wileyToken) {
    await throttle("wiley-tdm");
    const r = await wileyTdmFetch(doi, { token: settings.wileyToken });
    if (r.found) {
      const filename = await downloadBlob(r.blob, doi, subfolder);
      return { doi, source: "tdm", publisher, filename };
    } else {
      console.warn("Wiley TDM failed for", doi, "status:", r.status, r.reason);
    }
  }

  // Step 6: Institutional link resolver — uses the user's own session.
  if (settings.resolverBase) {
    await throttle(publisher);
    const r = await resolveOpenUrl(doi, settings.resolverBase);
    if (r.found && r.url) {
      const fetched = await fetchWithSession(r.url);
      if (fetched.ok) {
        const filename = await downloadBlob(fetched.blob, doi, subfolder);
        return { doi, source: "institutional", publisher, via: r.url, filename };
      }
    }
  }

  return { doi, source: "unavailable", publisher };
}

async function processItem(item, settings, subfolder) {
  if (item.type === "arxiv") return handleArxiv(item, settings, subfolder);
  if (item.type === "openreview") return handleOpenReview(item, settings, subfolder);
  return handleDoi(item, settings, subfolder);
}

// Long-lived connection from popup → process job.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fetch-job") return;
  let cancelled = false;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "cancel") { cancelled = true; return; }
    if (msg.type !== "start") return;

    // Backwards-compat: if popup sends `dois` (strings), wrap them as DOI items.
    const items = msg.items
      || (msg.dois || []).map((d) => ({ type: "doi", value: d, original: d }));

    const subfolder = msg.subfolder || "icompletist";
    const settings = await getSettings();
    const summary = { pmc: 0, oa: 0, institutional: 0, tdm: 0, unavailable: 0 };

    const runId = await startRun(items);

    for (let i = 0; i < items.length; i++) {
      if (cancelled) break;
      const item = items[i];
      port.postMessage({ type: "progress", done: i, total: items.length, currentDoi: item.value });
      try {
        const result = await processItem(item, settings, subfolder);
        summary[result.source] = (summary[result.source] || 0) + 1;
        await appendToRun(runId, result);
        port.postMessage({ type: "result", result });
      } catch (e) {
        summary.unavailable++;
        const failed = { doi: item.value, source: "unavailable", error: e.message };
        await appendToRun(runId, failed);
        port.postMessage({ type: "result", result: failed });
      }
    }
    await finishRun(runId, summary);
    port.postMessage({ type: "progress", done: items.length, total: items.length });
    port.postMessage({ type: "done", summary });
  });
});
