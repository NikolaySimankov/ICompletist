// offscreen.js - PDF → raw text extraction via pdf.js.
//
// Runs in a hidden offscreen document (a real DOM page) because:
//   - the MV3 service worker can't host pdf.js's worker, and
//   - pdf.js text extraction is reliable in a normal page context.
//
// background.js sends { type: "extract-text", dataBase64 } and gets back
// { ok, text } | { ok:false, error }. We use pdf.js getTextContent() directly
// — raw text, no markdown heuristics (those are what mangle tables with ```).

import * as pdfjsLib from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.mjs");

function base64ToUint8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Reconstruct readable lines from pdf.js text items. `hasEOL` marks line ends;
// otherwise we insert a space between items on the same line. Collapse the
// stray whitespace that PDFs are full of.
function itemsToText(items) {
  let out = "";
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    out += it.str;
    if (it.hasEOL) out += "\n";
    else if (it.str && !it.str.endsWith(" ")) out += " ";
  }
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

async function extractText(dataBase64) {
  const data = base64ToUint8(dataBase64);
  const pdf = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,   // extension CSP forbids eval
    disableFontFace: true,    // text extraction doesn't need font rendering
    useSystemFonts: false,
  }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(itemsToText(content.items));
    page.cleanup();
  }
  await pdf.destroy();
  // Page break marker between pages keeps text-mining tools able to split.
  return pages.join("\n\n");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "extract-text") return;
  extractText(msg.dataBase64)
    .then((text) => sendResponse({ ok: true, text }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // async response
});
