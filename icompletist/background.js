// background.js - service worker orchestrating the fetch pipeline.
//
// Architecture:
//   1. Pre-pass: batch-query Semantic Scholar for ALL input DOIs at once
//      (up to 500 per request) to get OA PDF URLs. Cache the results.
//   2. Worker pool: process items concurrently (default 5 in parallel).
//      Per-source throttling (2s gap per publisher domain) still applies and
//      serializes naturally across workers since the throttle Map is shared.
//   3. Per-item: try sources in order. The S2 cache gives an instant
//      shortcut when we already know an OA URL.

import { unpaywallLookup } from "./lib/unpaywall.js";
import { pmcLookup } from "./lib/pmc.js";
import { arxivFetch, arxivIdFromDoi } from "./lib/arxiv.js";
import { biorxivFetch, isBiorxivDoi } from "./lib/biorxiv.js";
import { openreviewFetch } from "./lib/openreview.js";
import { ieeeOaFetch, isIeeeDoi } from "./lib/ieee.js";
import { elsevierTdmFetch } from "./lib/elsevier.js";
import { springerTdmFetch } from "./lib/springer.js";
import { wileyTdmFetch } from "./lib/wiley.js";
import { coreLookup } from "./lib/core.js";
import { s2BatchLookup } from "./lib/semanticscholar.js";
import { resolveOpenUrl, fetchWithSession } from "./lib/resolver.js";
import { startRun, appendToRun, finishRun } from "./lib/history.js";
import { isPdfBlob, describeBlob } from "./lib/pdfcheck.js";

// Throttle: minimum gap between hits to the same publisher domain.
const PUBLISHER_DELAY_MS = 2000;
const lastHit = new Map();

// Concurrency: max DOIs being processed in parallel. OA sources don't share
// throttles so they pipeline well; paywalled sources will serialize naturally
// via the per-domain throttle.
const MAX_CONCURRENT = 5;

async function throttle(domain) {
  // Serialize calls to the same domain across all workers.
  const now = Date.now();
  const prev = lastHit.get(domain) || 0;
  const wait = Math.max(0, PUBLISHER_DELAY_MS - (now - prev));
  // Update lastHit BEFORE the wait so the next caller doesn't read a stale value.
  lastHit.set(domain, now + wait);
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      {
        email: "",
        ncbiApiKey: "",
        s2ApiKey: "",
        coreApiKey: "",
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
    "10.1038": "springer",
    "10.1186": "springer",
    "10.1002": "wiley",
    "10.1111": "wiley",
    "10.1101": "biorxiv",
    "10.1109": "ieee",
    "10.1126": "aaas",
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

// Try fetching a known PDF URL and downloading it. Returns filename or null.
async function tryDirectPdf(pdfUrl, identifier, subfolder) {
  try {
    const res = await fetch(pdfUrl, { redirect: "follow" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!(await isPdfBlob(blob))) {
      console.info(`tryDirectPdf: non-PDF response from ${pdfUrl} —`, await describeBlob(blob));
      return null;
    }
    return await downloadBlob(blob, identifier, subfolder);
  } catch (e) {
    return null;
  }
}

// ---- Per-type handlers ----

async function handleArxiv(item, settings, subfolder) {
  const display = `arxiv:${item.value}`;
  try {
    const r = await arxivFetch(item.value);
    if (r.found) {
      const filename = await downloadBlob(r.blob, display, subfolder);
      return { doi: display, source: "oa", arxivId: r.arxivId, filename };
    }
    return {
      doi: display, source: "unavailable", error: r.reason,
      tryUrls: [
        { url: `https://arxiv.org/abs/${item.value}`, label: "arXiv abstract" },
        { url: `https://arxiv.org/pdf/${item.value}`, label: "arXiv PDF (direct)" },
      ],
    };
  } catch (e) {
    console.warn("arXiv error for", display, e);
    return {
      doi: display, source: "unavailable", error: e.message,
      tryUrls: [{ url: `https://arxiv.org/abs/${item.value}`, label: "arXiv abstract" }],
    };
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
    return {
      doi: display, source: "unavailable", error: r.reason,
      tryUrls: [
        { url: `https://openreview.net/forum?id=${item.value}`, label: "OpenReview forum" },
        { url: `https://openreview.net/pdf?id=${item.value}`, label: "OpenReview PDF (direct)" },
      ],
    };
  } catch (e) {
    console.warn("OpenReview error for", display, e);
    return {
      doi: display, source: "unavailable", error: e.message,
      tryUrls: [{ url: `https://openreview.net/forum?id=${item.value}`, label: "OpenReview forum" }],
    };
  }
}

async function handleDoi(item, settings, subfolder, s2Cache) {
  const doi = item.value;
  const publisher = publisherFromDoi(doi);
  console.info(`[${doi}] handleDoi start, publisher=${publisher}, biorxiv=${isBiorxivDoi(doi)}, arxiv=${!!arxivIdFromDoi(doi)}`);

  // Accumulator: every URL we got from an API but failed to download.
  // These are shown to the user so they can try opening them manually.
  const tryUrls = [];
  const seen = new Set();
  const recordUrl = (url, label) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    tryUrls.push({ url, label });
  };

  // ----- Early routing for DOIs that have a definitive native source.
  const arxivId = arxivIdFromDoi(doi);
  if (arxivId) {
    console.info(`[${doi}] trying arXiv direct (${arxivId})`);
    try {
      const r = await arxivFetch(arxivId);
      if (r.found) {
        const filename = await downloadBlob(r.blob, doi, subfolder);
        return { doi, source: "oa", via: "arxiv", arxivId: r.arxivId, filename };
      }
      // arXiv failed, but the URL is deterministic — record the article page.
      recordUrl(`https://arxiv.org/abs/${arxivId}`, "arXiv abstract");
      console.info(`[${doi}] arXiv miss:`, r.reason);
    } catch (e) {
      console.warn(`[${doi}] arXiv error:`, e);
    }
  }

  if (isBiorxivDoi(doi)) {
    console.info(`[${doi}] trying bioRxiv direct`);
    try {
      const r = await biorxivFetch(doi);
      if (r.found) {
        const filename = await downloadBlob(r.blob, doi, subfolder);
        return { doi, source: "oa", via: r.server, publisher: r.server, filename };
      }
      // bioRxiv API confirms the preprint exists — record its landing page.
      const host = doi.includes("medrxiv") ? "www.medrxiv.org" : "www.biorxiv.org";
      recordUrl(`https://${host}/content/${doi}`, "bioRxiv article page");
      console.info(`[${doi}] bioRxiv miss:`, r.reason, r.status ? `(status ${r.status})` : "");
    } catch (e) {
      console.warn(`[${doi}] bioRxiv error:`, e);
    }
  }

  // ----- Generic pipeline -----

  // Step 1: Semantic Scholar cache shortcut.
  if (s2Cache && s2Cache.has(doi)) {
    const hit = s2Cache.get(doi);
    if (hit && hit.url) {
      console.info(`[${doi}] trying S2 cached URL: ${hit.url}`);
      const filename = await tryDirectPdf(hit.url, doi, subfolder);
      if (filename) {
        return { doi, source: "oa", via: "semanticscholar", license: hit.license, filename };
      }
      recordUrl(hit.url, "Semantic Scholar OA link");
      console.info(`[${doi}] S2 URL was not a valid PDF, invalidating cache`);
      s2Cache.set(doi, undefined);
    } else {
      console.info(`[${doi}] S2 has no OA URL for this DOI`);
    }
  } else {
    console.info(`[${doi}] not in S2 cache`);
  }

  // Step 2: CORE.
  if (settings.coreApiKey) {
    console.info(`[${doi}] trying CORE`);
    try {
      await throttle("core");
      const r = await coreLookup(doi, { apiKey: settings.coreApiKey });
      if (r.found) {
        const filename = await downloadBlob(r.blob, doi, subfolder);
        return { doi, source: "oa", via: "core", title: r.title, filename };
      }
      if (r.attemptedUrl) recordUrl(r.attemptedUrl, "CORE PDF URL");
      console.info(`[${doi}] CORE miss:`, r.reason);
    } catch (e) {
      console.warn(`[${doi}] CORE error:`, e);
    }
  } else {
    console.info(`[${doi}] skipping CORE (no key)`);
  }

  // Step 3: Publisher TDM APIs.
  if (publisher === "elsevier" && settings.elsevierKey) {
    console.info(`[${doi}] trying Elsevier TDM`);
    await throttle("elsevier-tdm");
    const r = await elsevierTdmFetch(doi, {
      apiKey: settings.elsevierKey,
      instToken: settings.elsevierInstToken,
    });
    if (r.found) {
      const filename = await downloadBlob(r.blob, doi, subfolder);
      return { doi, source: "tdm", publisher, filename };
    }
    console.info(`[${doi}] Elsevier TDM miss:`, r.reason, r.status ? `(${r.status})` : "");
  }
  if (publisher === "springer" && settings.springerKey) {
    console.info(`[${doi}] trying Springer TDM`);
    await throttle("springer-tdm");
    const r = await springerTdmFetch(doi, { apiKey: settings.springerKey });
    if (r.found) {
      const filename = await downloadBlob(r.blob, doi, subfolder);
      return { doi, source: "tdm", publisher, filename };
    }
    console.info(`[${doi}] Springer TDM miss:`, r.reason);
  }
  if (publisher === "wiley" && settings.wileyToken) {
    console.info(`[${doi}] trying Wiley TDM`);
    await throttle("wiley-tdm");
    const r = await wileyTdmFetch(doi, { token: settings.wileyToken });
    if (r.found) {
      const filename = await downloadBlob(r.blob, doi, subfolder);
      return { doi, source: "tdm", publisher, filename };
    }
    console.info(`[${doi}] Wiley TDM miss:`, r.reason, r.status ? `(${r.status})` : "");
  }

  // Step 4: Unpaywall. Always try — S2 and Unpaywall sometimes disagree about
  // OA status, and we want every chance at a legal PDF.
  if (settings.email) {
    console.info(`[${doi}] trying Unpaywall`);
    try {
      const up = await unpaywallLookup(doi, settings.email);
      if (up.found) {
        const pdfRes = await fetch(up.pdfUrl);
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          if (await isPdfBlob(blob)) {
            const filename = await downloadBlob(blob, doi, subfolder);
            return { doi, source: "oa", via: "unpaywall", title: up.title, license: up.license, filename };
          }
          console.warn(`[${doi}] Unpaywall returned non-PDF:`, await describeBlob(blob));
        } else {
          console.info(`[${doi}] Unpaywall PDF fetch returned ${pdfRes.status}`);
        }
      } else {
        console.info(`[${doi}] Unpaywall: no OA copy`);
      }
      if (Array.isArray(up.candidateUrls)) {
        for (const u of up.candidateUrls) recordUrl(u, "Unpaywall OA location");
      }
    } catch (e) {
      console.warn(`[${doi}] Unpaywall error:`, e);
    }
  } else {
    console.info(`[${doi}] skipping Unpaywall (no email configured)`);
  }

  // Step 5: PMC.
  console.info(`[${doi}] trying PMC`);
  try {
    await throttle("ncbi");
    const pmc = await pmcLookup(doi, { email: settings.email, apiKey: settings.ncbiApiKey });
    if (pmc.found) {
      const filename = await downloadBlob(pmc.blob, doi, subfolder);
      return { doi, source: "pmc", pmcid: pmc.pmcid, filename };
    }
    // If we got a PMCID but no PDF, the article page is still useful.
    if (pmc.pmcid) {
      recordUrl(`https://www.ncbi.nlm.nih.gov/pmc/articles/${pmc.pmcid}/`, "PMC article page");
    }
    console.info(`[${doi}] PMC miss:`, pmc.reason);
  } catch (e) {
    console.warn(`[${doi}] PMC error:`, e);
  }

  // Step 6: IEEE OA.
  if (isIeeeDoi(doi) && settings.ieeeKey) {
    console.info(`[${doi}] trying IEEE OA`);
    try {
      await throttle("ieee");
      const r = await ieeeOaFetch(doi, { apiKey: settings.ieeeKey });
      if (r.found) {
        const filename = await downloadBlob(r.blob, doi, subfolder);
        return { doi, source: "oa", via: "ieee", publisher: "ieee", filename };
      }
      console.info(`[${doi}] IEEE miss:`, r.reason);
    } catch (e) {
      console.warn(`[${doi}] IEEE error:`, e);
    }
  }

  // Step 7: Institutional resolver.
  if (settings.resolverBase) {
    console.info(`[${doi}] trying institutional resolver`);
    await throttle(publisher);
    const r = await resolveOpenUrl(doi, settings.resolverBase);
    if (r.found && r.url) {
      const fetched = await fetchWithSession(r.url);
      if (fetched.ok) {
        const filename = await downloadBlob(fetched.blob, doi, subfolder);
        return { doi, source: "institutional", publisher, via: r.url, filename };
      }
      // Resolver returned a URL we couldn't auto-fetch — user can try it manually.
      recordUrl(r.url, "Institutional resolver link");
    }
  }

  // Always include the DOI resolver itself as a last-resort link.
  recordUrl(`https://doi.org/${doi}`, "DOI landing page");

  console.info(`[${doi}] all sources exhausted → unavailable (${tryUrls.length} URLs to try manually)`);
  return { doi, source: "unavailable", publisher, tryUrls };
}

async function processItem(item, settings, subfolder, s2Cache) {
  if (item.type === "arxiv") return handleArxiv(item, settings, subfolder);
  if (item.type === "openreview") return handleOpenReview(item, settings, subfolder);
  return handleDoi(item, settings, subfolder, s2Cache);
}

// ---- Worker pool ----
// Pulls items from a shared index. Each worker processes one item at a time
// and reports back to the port. Throttling across workers is handled by the
// global lastHit Map.
async function runPool(items, settings, subfolder, s2Cache, onResult, isCancelled) {
  let next = 0;
  const total = items.length;

  async function worker() {
    while (true) {
      if (isCancelled()) return;
      const i = next++;
      if (i >= total) return;
      const item = items[i];
      onResult({ type: "progress", done: i, total, currentDoi: item.value });
      try {
        const result = await processItem(item, settings, subfolder, s2Cache);
        onResult({ type: "result", result });
      } catch (e) {
        onResult({ type: "result", result: { doi: item.value, source: "unavailable", error: e.message } });
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, total) }, worker);
  await Promise.all(workers);
}

// Long-lived connection from popup → process job.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "fetch-job") return;
  let cancelled = false;
  let portAlive = true;

  // The popup can close at any time; in that case the port disconnects and
  // any further postMessage() would throw. We keep the pool running (so
  // history still records results) but silently drop messages.
  port.onDisconnect.addListener(() => { portAlive = false; });

  const safePost = (msg) => {
    if (!portAlive) return;
    try { port.postMessage(msg); }
    catch { portAlive = false; }
  };

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "cancel") { cancelled = true; return; }
    if (msg.type !== "start") return;

    const items = msg.items
      || (msg.dois || []).map((d) => ({ type: "doi", value: d, original: d }));

    const subfolder = msg.subfolder || "icompletist";
    const settings = await getSettings();
    const summary = { pmc: 0, oa: 0, institutional: 0, tdm: 0, unavailable: 0 };

    const runId = await startRun(items);

    // Pre-pass: batch-query Semantic Scholar for DOI items only.
    let s2Cache = new Map();
    const doiValues = items.filter((it) => it.type === "doi").map((it) => it.value);
    if (doiValues.length) {
      safePost({ type: "progress", done: 0, total: items.length, currentDoi: `Pre-fetching OA URLs from Semantic Scholar (${doiValues.length} DOIs)…` });
      try {
        s2Cache = await s2BatchLookup(doiValues, { apiKey: settings.s2ApiKey });
        console.info(`S2 pre-pass: resolved ${s2Cache.size}/${doiValues.length} DOIs`);
      } catch (e) {
        console.warn("S2 batch pre-pass failed:", e);
      }
    }

    await runPool(
      items,
      settings,
      subfolder,
      s2Cache,
      async (msg) => {
        if (msg.type === "result") {
          summary[msg.result.source] = (summary[msg.result.source] || 0) + 1;
          await appendToRun(runId, msg.result);
        }
        safePost(msg);
      },
      () => cancelled
    );

    await finishRun(runId, summary);
    safePost({ type: "progress", done: items.length, total: items.length });
    safePost({ type: "done", summary });
  });
});
