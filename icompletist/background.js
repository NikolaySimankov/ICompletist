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
import { startRun, appendToRun, finishRun, replaceRunResults, getRuns } from "./lib/history.js";
import { isPdfBlob, describeBlob } from "./lib/pdfcheck.js";
import { runSearch, buildQueries } from "./lib/search/orchestrate.js";
import { selectArticles } from "./lib/search/select.js";
import { crossrefLookup, mergeMeta, enrichItems } from "./lib/enrich.js";
import { doiFromUrl } from "./lib/urlresolve.js";

// Throttle: minimum gap between hits to the same publisher domain.
//
// Before v2.0.0-beta5 every domain shared a single 2000ms ceiling — a value
// chosen to respect Wiley's "≤1 req/s" TDM limit. The cost was that OA
// aggregators (CORE, PMC) — which actually support 5-10 req/s — were
// throttled to the same conservative rate, so OA-heavy batches spent most
// of their wall time in throttle waits even though no upstream API would
// have complained.
//
// The per-domain table below matches each source to its published rate
// limit (or a safe estimate when the docs are vague). For a typical 30-DOI
// OA-heavy batch this cuts wall time roughly 10×.
const DEFAULT_DELAY_MS = 500;
const DOMAIN_DELAYS_MS = {
  // Publisher TDM endpoints — strict ceilings, respect them.
  "wiley-tdm": 2000,    // Wiley docs: ≤1 req/s
  "elsevier-tdm": 1000, // Elsevier ~2 req/s in practice; be conservative
  "springer-tdm": 500,  // No strict limit documented
  // OA aggregators — generous limits, no reason to slow-walk them.
  "core": 200,          // CORE docs: ~10 req/s; 5 req/s leaves headroom
  "ncbi": 350,          // NCBI: 3 req/s without API key, 10 with one — safe for both
  "ieee": 500,          // IEEE has daily quotas, not strict per-second limits
  "crossref": 100,      // Crossref polite pool is generous (~50 req/s); 10 req/s is plenty
};
const lastHit = new Map();

// Concurrency: max DOIs being processed in parallel. OA sources don't share
// throttles so they pipeline well; paywalled sources will serialize naturally
// via the per-domain throttle.
const MAX_CONCURRENT = 5;

async function throttle(domain) {
  // Serialize calls to the same domain across all workers using the
  // domain-specific delay. Falls back to DEFAULT_DELAY_MS for any domain
  // not in the table (e.g. publisher names from publisherFromDoi when used
  // as the institutional resolver throttle key).
  const delay = DOMAIN_DELAYS_MS[domain] ?? DEFAULT_DELAY_MS;
  const now = Date.now();
  const prev = lastHit.get(domain) || 0;
  const wait = Math.max(0, delay - (now - prev));
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
    // Elsevier family
    "10.1016": "elsevier",
    "10.1006": "elsevier",
    // Springer Nature family
    "10.1007": "springer",
    "10.1038": "springer",
    "10.1186": "springer",
    "10.1057": "springer", // Palgrave Macmillan
    // Wiley family
    "10.1002": "wiley",
    "10.1111": "wiley",
    // Preprint servers
    "10.1101": "biorxiv",
    // IEEE
    "10.1109": "ieee",
    // Society / society-affiliated publishers
    "10.1126": "aaas",            // Science
    "10.1093": "oup",             // Oxford University Press
    "10.1080": "taylor-francis",
    "10.1371": "plos",            // PLOS — fully OA, Unpaywall usually finds these fast
    "10.3389": "frontiers",       // Frontiers — fully OA
    "10.1073": "pnas",            // PNAS — mixed OA / hybrid
    "10.1098": "royalsociety",    // Royal Society journals
    "10.1039": "rsc",             // Royal Society of Chemistry
    "10.1021": "acs",             // American Chemical Society — paywalled, no TDM module yet
    "10.1094": "aps",             // American Phytopathological Society
    "10.1146": "annualreviews",   // Annual Reviews
    "10.4049": "aai",             // American Association of Immunologists
    "10.1158": "aacr",            // American Association for Cancer Research
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

// Reproduce the filename normalization downloadBlob uses, without performing
// the download. Used by the "already on disk?" pre-check.
function expectedFilename(identifier, subfolder) {
  const safe = identifier.replace(/[^a-z0-9]+/gi, "_");
  const folder = (subfolder || "icompletist").replace(/[<>:"|?*\x00-\x1f]/g, "_");
  return { folder, safe, relative: `${folder}/${safe}.pdf` };
}

const REGEX_ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;
const escRe = (s) => s.replace(REGEX_ESCAPE_RE, "\\$&");

// Check Chrome's download history for a previously-saved PDF matching this
// identifier in the target subfolder. Returns the relative filename if a
// matching file is still on disk (per Chrome's `exists` flag), else null.
//
// Why this works: chrome.downloads.search queries Chrome's own download
// database (not the filesystem directly), but its `exists` field is updated
// when Chrome notices the file is gone, so it's a decent proxy. Matching is
// done by regex against the absolute path because we don't know the user's
// Downloads directory location. The optional " (N)" group accommodates
// Chrome's uniquify behavior — earlier runs may have saved foo.pdf, foo (1).pdf
// and we treat any of them as "already downloaded".
async function checkAlreadyDownloaded(identifier, subfolder) {
  const { folder, safe } = expectedFilename(identifier, subfolder);
  // Match {folder}{sep}{safe}(?: (N))?.pdf at end of absolute path, on both
  // POSIX and Windows. In the regex source: [/\\\\] → [/\\] in the string →
  // matches either separator literally.
  const pattern = `${escRe(folder)}[/\\\\]${escRe(safe)}(?:\\s\\(\\d+\\))?\\.pdf$`;
  try {
    const results = await chrome.downloads.search({
      filenameRegex: pattern,
      state: "complete",
      limit: 5,
    });
    const hit = results.find((r) => r.exists);
    if (!hit) return null;
    // Normalize the absolute path Chrome returned into a relative tail that
    // matches what downloadBlob would have returned, so downstream code
    // (history, RIS export's L1 file:// builder) keeps working unchanged.
    const normalized = hit.filename.replace(/\\/g, "/");
    const marker = `/${folder.toLowerCase()}/`;
    const idx = normalized.toLowerCase().lastIndexOf(marker);
    return idx >= 0 ? normalized.slice(idx + 1) : normalized;
  } catch (e) {
    console.warn(`checkAlreadyDownloaded(${identifier}) error:`, e);
    return null;
  }
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

  // Step 1: Publisher-native authoritative APIs.
  //
  // For DOIs whose publisher we recognize AND whose key/token the user has
  // configured, this is the legitimate institutional access path — it
  // returns the publisher's own PDF and usually beats any OA preprint we
  // might find later. Trying these first also avoids wasted CORE / Unpaywall
  // / PMC roundtrips for items those aggregators rarely hold (Elsevier /
  // Wiley / Springer paywalled content). The OA cascade below still runs
  // as a fallback when the publisher API is unconfigured or misses.
  //
  // Each guard is double: (publisher prefix match) AND (key configured).
  // For a DOI outside the Elsevier/Springer/Wiley/IEEE prefix space (e.g.
  // PLOS 10.1371, ACS 10.1021, APS 10.1094), every check below short-
  // circuits on the prefix test — zero wasted network calls, zero throttle
  // wait. The item drops straight into Step 2.
  if (publisher === "elsevier" && settings.elsevierKey) {
    console.info(`[${doi}] trying Elsevier TDM (publisher match, key configured)`);
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
    console.info(`[${doi}] trying Springer TDM (publisher match, key configured)`);
    await throttle("springer-tdm");
    const r = await springerTdmFetch(doi, { apiKey: settings.springerKey });
    if (r.found) {
      const filename = await downloadBlob(r.blob, doi, subfolder);
      return { doi, source: "tdm", publisher, filename };
    }
    console.info(`[${doi}] Springer TDM miss:`, r.reason);
  }
  if (publisher === "wiley" && settings.wileyToken) {
    console.info(`[${doi}] trying Wiley TDM (publisher match, token configured)`);
    await throttle("wiley-tdm");
    const r = await wileyTdmFetch(doi, { token: settings.wileyToken });
    if (r.found) {
      const filename = await downloadBlob(r.blob, doi, subfolder);
      return { doi, source: "tdm", publisher, filename };
    }
    console.info(`[${doi}] Wiley TDM miss:`, r.reason, r.status ? `(${r.status})` : "");
  }
  if (isIeeeDoi(doi) && settings.ieeeKey) {
    console.info(`[${doi}] trying IEEE OA (publisher match, key configured)`);
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

  // Step 2: Semantic Scholar cache shortcut.
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

  // Step 3: CORE.
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

  // Step 6: Institutional resolver.
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

// ENRICH (fetch-mode): fill bibliographic metadata via Crossref for any
// result carrying a real DOI, so the RIS export for a Fetch-by-ID / URL run
// is identical to a Search run. Runs per-item inside the worker pool and
// shares the "crossref" throttle key across workers. Mutates result in place.
async function enrichResult(result, settings) {
  if (!result) return;
  const raw = String(result.doi || "");
  if (!/^10\.\d{4,9}\//i.test(raw)) return; // arXiv/OpenReview/unresolved — Crossref won't have it
  if (result.title && result.year && result.journal && result.authors?.length) return; // already complete
  try {
    await throttle("crossref");
    const meta = await crossrefLookup(raw, settings.email);
    if (meta) mergeMeta(result, meta);
  } catch (e) {
    console.warn(`[${raw}] enrich error:`, e);
  }
}

async function processItem(item, settings, subfolder, s2Cache) {
  // URL items: resolve to a DOI first so the cache check, fetch cascade, and
  // enrichment all operate on a real identifier — making a pasted URL behave
  // exactly like a pasted DOI.
  let workItem = item;
  let sourceUrl = null;
  if (item.type === "url") {
    sourceUrl = item.value;
    console.info(`[url] resolving DOI for ${item.value}`);
    const doi = await doiFromUrl(item.value, settings);
    if (!doi) {
      console.info(`[url] no DOI found on ${item.value}`);
      return {
        doi: item.value, source: "unavailable", sourceUrl,
        error: "Could not find a DOI on that page",
        tryUrls: [{ url: item.value, label: "Original URL" }],
      };
    }
    console.info(`[url] ${item.value} → ${doi}`);
    workItem = { type: "doi", value: doi, original: item.original };
  }

  // Pre-check: if a PDF for this identifier already exists in the target
  // subfolder from an earlier run, skip the entire fetch cascade. We use
  // the same display ID that downloadBlob would have used so the regex
  // matches exactly.
  const displayId = workItem.type === "arxiv" ? `arxiv:${workItem.value}`
    : workItem.type === "openreview" ? `openreview:${workItem.value}`
    : workItem.value;

  let result;
  const existing = await checkAlreadyDownloaded(displayId, subfolder);
  if (existing) {
    console.info(`[${displayId}] already on disk, skipping (${existing})`);
    result = { doi: displayId, source: "cached", filename: existing };
  } else if (workItem.type === "arxiv") {
    result = await handleArxiv(workItem, settings, subfolder);
  } else if (workItem.type === "openreview") {
    result = await handleOpenReview(workItem, settings, subfolder);
  } else {
    result = await handleDoi(workItem, settings, subfolder, s2Cache);
  }

  // Carry the originating URL through for RIS / history.
  if (sourceUrl && result && !result.sourceUrl) result.sourceUrl = sourceUrl;

  // ENRICH every result (cached, downloaded, or unavailable) so RIS is
  // complete regardless of download outcome.
  await enrichResult(result, settings);
  return result;
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
        // Tag with the original input so resume can tell what's been done.
        result.original = item.original;
        onResult({ type: "result", result });
      } catch (e) {
        onResult({ type: "result", result: { doi: item.value, original: item.original, source: "unavailable", error: e.message } });
      }
    }
  }

  const workers = Array.from({ length: Math.min(MAX_CONCURRENT, total) }, worker);
  await Promise.all(workers);
}

// Keepalive: the popup/tab sends a no-op ping every 25 s while a job is
// running. Receiving any message resets Chrome's 5-minute service-worker
// idle timer, preventing the worker from being killed mid-batch.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "keepalive") return; // receipt alone resets the timer
});

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
    const summary = { pmc: 0, oa: 0, institutional: 0, tdm: 0, cached: 0, unavailable: 0 };

    // Resume mode: append to an existing (interrupted) run rather than
    // creating a new one. `items` here are only the not-yet-processed items;
    // we seed the summary from the results already in the run so the final
    // tally is cumulative.
    let runId;
    if (msg.resumeRunId) {
      runId = msg.resumeRunId;
      const existing = (await getRuns()).find((r) => r.id === runId);
      for (const res of existing?.results || []) {
        summary[res.source] = (summary[res.source] || 0) + 1;
      }
      console.info(`Resuming run ${runId}: ${items.length} item(s) remaining`);
    } else {
      runId = await startRun(items, { subfolder });
    }

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

// ---- Search job handler ----
// A separate port channel for SEARCH runs. The popup connects to "search-job",
// posts a message of shape:
//   { type: "start", spec, sources, limit }
// and receives:
//   { type: "queries", queries }                — the per-DB query strings
//   { type: "source-progress", source, done, total }
//   { type: "source-complete", source, items: N, total, error }
//   { type: "done", items: [...], perSource, runId }
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "search-job") return;
  let portAlive = true;
  let cancelled = false;
  port.onDisconnect.addListener(() => { portAlive = false; });
  const safePost = (msg) => {
    if (!portAlive) return;
    try { port.postMessage(msg); } catch { portAlive = false; }
  };

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "cancel") { cancelled = true; return; }
    if (msg.type !== "start") return;

    const { spec, sources, limit } = msg;
    // ENSURE defaults to on; the popup sends ensure:false when the user
    // unchecks the precision filter.
    const ensureEnabled = msg.ensure !== false;
    const settings = await getSettings();
    const queries = buildQueries(spec);
    safePost({ type: "queries", queries });

    // Create the run in history immediately so partial progress is recoverable.
    const runId = await startRun([], {
      kind: "search",
      spec,
      sources,
      queries,
      ensure: ensureEnabled,
    });

    try {
      const { items, perSource } = await runSearch(spec, {
        sources,
        limit,
        settings,
        onSourceProgress: (src, p) => {
          if (cancelled) return;
          safePost({ type: "source-progress", source: src, done: p.done, total: p.total });
        },
        onSourceComplete: (src, r) => {
          safePost({
            type: "source-complete",
            source: src,
            items: r.items.length,
            total: r.total,
            error: r.error,
          });
        },
      });

      if (cancelled) {
        safePost({ type: "done", items: [], perSource, runId, cancelled: true });
        return;
      }

      // ----- Post-search pipeline: ENRICH → ENSURE -----
      //
      // SEARCH and DEDUPLICATE already happened inside runSearch. The two
      // stages below run automatically on every search.

      // ENRICH: fill missing title / authors / year / journal / volume /
      // pages / abstract / keywords via Crossref so search-mode RIS is
      // complete and identical to fetch-mode. Items only ever flow
      // null→value (mergeMeta), so the stage is idempotent and never
      // clobbers richer data a search source already supplied. This is
      // also what lets ENSURE work on PubMed-only hits, which arrive with
      // no abstract from esummary.
      safePost({ type: "stage", stage: "enrich", before: items.length, after: items.length });
      const enriched = await enrichItems(items, {
        email: settings.email,
        onProgress: (p) => safePost({ type: "enrich-progress", done: p.done, total: p.total }),
      });

      // ENSURE (optional): re-apply the original spec locally against title +
      // abstract + journal, dropping items the databases ranked in but that
      // don't actually contain the query terms. Skipped when the user
      // unchecks the precision filter.
      let ensured;
      if (ensureEnabled) {
        ensured = selectArticles(enriched, spec);
        safePost({ type: "stage", stage: "ensure", before: enriched.length, after: ensured.length });
      } else {
        ensured = enriched;
        safePost({ type: "stage", stage: "ensure", before: enriched.length, after: enriched.length, skipped: true });
      }

      // Persist the post-ENSURE items as the run's results. We store the
      // rich metadata (title, year, journal, abstract if present) so the
      // user can browse the search results later and optionally hand them
      // off to the PDF download pipeline.
      const results = ensured.map((it) => ({
        doi: it.doi || it.arxivId ? (it.doi || `arxiv:${it.arxivId}`) : (it.title || it.id),
        source: "search",
        // Carry richer fields — these all flow straight into RIS export
        // (AU/PY/JO/VL/SP/EP/AB/KW) without the user re-fetching anything.
        // `keywords` is the slot for the v2.1 ENRICH cascade.
        title: it.title || null,
        year: it.year || null,
        journal: it.journal || null,
        volume: it.volume || null,
        pages: it.pages || null,
        authors: it.authors || [],
        abstract: it.abstract || null,
        keywords: Array.isArray(it.keywords) ? it.keywords : null,
        sources: it.sources || [],
        identifiers: {
          doi: it.doi || null,
          pmid: it.pmid || null,
          pmcid: it.pmcid || null,
          arxivId: it.arxivId || null,
          s2Id: it.s2Id || null,
          coreId: it.coreId || null,
          scopusId: it.scopusId || null,
          ieeeArticleNumber: it.ieeeArticleNumber || null,
        },
        openAccessUrl: it.openAccessUrl || null,
        sourceUrl: it.sourceUrl || null,
        at: Date.now(),
      }));
      await replaceRunResults(runId, results);

      const summary = {
        total: ensured.length,
        searchCount: items.length,
        enrichCount: enriched.length,
        ensureCount: ensured.length,
        ...Object.fromEntries(
          Object.entries(perSource).map(([k, v]) => [k, v.error ? `error: ${v.error}` : v.items.length])
        ),
      };
      await finishRun(runId, summary);

      safePost({
        type: "done",
        items: ensured,
        perSource,
        runId,
        searchCount: items.length,
        enrichCount: enriched.length,
        ensureCount: ensured.length,
      });
    } catch (e) {
      console.error("Search job failed:", e);
      safePost({ type: "done", items: [], perSource: {}, error: e.message, runId });
    }
  });
});
