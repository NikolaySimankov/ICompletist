// lib/risexport.js - Build a RIS file from a run's results.
//
// Why RIS instead of BibTeX or CSL-JSON: it's the format Zotero, Mendeley,
// EndNote, and Papers all import cleanly, and it has a well-defined "file
// attachment" tag (L1) that lets us point at the PDF we downloaded.
//
// What we emit: every bibliographic field a run actually carries. For
// search-mode runs that's title, authors, year, journal, volume, pages,
// abstract, keywords (when the v2.1 ENRICH cascade lands), plus DOI/PMID/
// PMCID/arXiv identifiers as either DO/UR tags or N1 notes. For fetch-mode
// runs we still benefit from whatever the source handlers returned (e.g.
// Unpaywall and CORE both surface titles; arXiv/PMC surface their IDs) —
// these are preserved by history.js and emitted here.
//
// For fields we don't have, Zotero's DOI/PMID lookup on import will fill
// the gaps. The previous version of this file emitted nothing beyond the
// identifier and title on the theory that Zotero's lookup would handle
// everything — but that only works for items with a real DOI and lost all
// the rich metadata the SEARCH stage gathered.
//
// RIS reference for the tags we use:
//   TY  - Type of reference (JOUR = journal article)
//   T1  - Primary title
//   AU  - Author (repeatable, one per author)
//   PY  - Publication year
//   JO  - Journal name (full)
//   VL  - Volume
//   SP  - Start page
//   EP  - End page
//   AB  - Abstract
//   KW  - Keyword (repeatable)
//   DO  - DOI
//   UR  - URL (repeatable)
//   L1  - File attachment (local file path)
//   N1  - Notes (repeatable — used for PMID, PMCID, license, fallback URLs)
//   ER  - End of reference (required)
//
// Docs: https://en.wikipedia.org/wiki/RIS_(file_format)

function risEscape(value) {
  if (value == null) return "";
  // RIS uses CRLF line endings and doesn't support multi-line values for most
  // tags. Collapse whitespace and strip newlines.
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

// Convert an absolute OS path (POSIX or Windows) into a file:// URL.
//   "/home/alice/Downloads/x.pdf"      -> "file:///home/alice/Downloads/x.pdf"
//   "C:\\Users\\Alice\\Downloads\\x.pdf" -> "file:///C:/Users/Alice/Downloads/x.pdf"
function pathToFileUrl(absPath) {
  if (!absPath) return null;
  const norm = String(absPath).trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  const encoded = norm.split("/").map((seg) =>
    /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg) // keep "C:" drive letters
  ).join("/");
  const prefix = encoded.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${encoded}`;
}

function isAbsolutePath(p) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/");
}

// Produce the L1 value for a stored filename. Since v2.0.0-beta21 the fetch
// pipeline stores the real absolute on-disk path (captured from the downloads
// API), so we can emit a working file:// URL with no configuration. Older runs
// (or fallbacks) stored a relative "subfolder/name.pdf"; for those we prepend
// the user's configured Downloads path if available, else emit the relative
// path (works with Zotero's Linked Attachment Base Directory).
function risFileUrl(filename, downloadsPath) {
  if (!filename) return null;
  if (/^file:/i.test(filename)) return filename;
  if (isAbsolutePath(filename)) return pathToFileUrl(filename);
  if (downloadsPath) {
    const base = String(downloadsPath).trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\\/g, "/")
      .replace(/\/+$/g, "");
    return pathToFileUrl(`${base}/${String(filename).replace(/\\/g, "/")}`);
  }
  return filename; // relative — relies on Zotero's base directory
}

function entryFor(result, downloadsPath) {
  const lines = [];
  const ident = result.identifiers || {};
  // Search-mode results nest identifiers under `identifiers`; fetch-mode
  // results store them top-level. Read both so RIS works for either shape.
  const pmid = ident.pmid || result.pmid || null;
  const pmcid = ident.pmcid || result.pmcid || null;
  const arxivId = ident.arxivId || result.arxivId || null;
  const raw = String(result.doi || "");
  const isArxivPrefix = /^arxiv:/i.test(raw);
  const isOpenReviewPrefix = /^openreview:/i.test(raw);
  // A "real" DOI: starts with 10.<digits>/. Search-mode items use the title
  // or another identifier as the display string when no DOI is known, and
  // we must not treat those as DOIs.
  const realDoi = ident.doi || (/^10\.\d{4,9}\//i.test(raw) ? raw : null);

  lines.push("TY  - JOUR");

  if (result.title) lines.push(`T1  - ${risEscape(result.title)}`);

  // Authors — one AU per author. Zotero accepts both "Last, First" and full
  // names, so we pass through whatever the search adapter returned.
  if (Array.isArray(result.authors)) {
    for (const a of result.authors) {
      if (a) lines.push(`AU  - ${risEscape(a)}`);
    }
  }

  if (result.year) lines.push(`PY  - ${risEscape(result.year)}`);
  if (result.journal) lines.push(`JO  - ${risEscape(result.journal)}`);
  if (result.volume) lines.push(`VL  - ${risEscape(result.volume)}`);

  // Pages: "123-145" → SP/EP; bare "123" → SP only.
  if (result.pages) {
    const m = String(result.pages).match(/^\s*([^\s\-–—]+)\s*[-–—]\s*([^\s\-–—]+)\s*$/);
    if (m) {
      lines.push(`SP  - ${risEscape(m[1])}`);
      lines.push(`EP  - ${risEscape(m[2])}`);
    } else {
      lines.push(`SP  - ${risEscape(result.pages)}`);
    }
  }

  if (result.abstract) lines.push(`AB  - ${risEscape(result.abstract)}`);

  // Keywords — slot for the v2.1 ENRICH cascade (PubMed MeSH terms,
  // S2 fields of study, CrossRef subjects). Carries through if any adapter
  // or enricher populates result.keywords as an array.
  if (Array.isArray(result.keywords)) {
    for (const k of result.keywords) {
      if (k) lines.push(`KW  - ${risEscape(k)}`);
    }
  }

  // Primary identifier / URL block.
  if (realDoi) {
    lines.push(`DO  - ${risEscape(realDoi)}`);
    lines.push(`UR  - https://doi.org/${risEscape(realDoi)}`);
  } else if (isArxivPrefix) {
    const id = raw.replace(/^arxiv:/i, "");
    lines.push(`UR  - https://arxiv.org/abs/${risEscape(id)}`);
    lines.push(`N1  - arXiv ID: ${risEscape(id)}`);
  } else if (isOpenReviewPrefix) {
    const id = raw.replace(/^openreview:/i, "");
    lines.push(`UR  - https://openreview.net/forum?id=${risEscape(id)}`);
    lines.push(`N1  - OpenReview ID: ${risEscape(id)}`);
  } else if (result.sourceUrl) {
    // Search-mode item with no DOI / arXiv / OpenReview — fall back to
    // whatever source-specific landing URL we collected.
    lines.push(`UR  - ${risEscape(result.sourceUrl)}`);
  }

  // Open-access PDF location reported by the search adapters (S2, CORE).
  // Distinct from filename: this is a remote URL, not a local file.
  if (result.openAccessUrl) lines.push(`UR  - ${risEscape(result.openAccessUrl)}`);

  // Extra identifiers as notes — Zotero downstream lookups can use these.
  if (pmid) lines.push(`N1  - PMID: ${risEscape(pmid)}`);
  if (pmcid) lines.push(`N1  - PMCID: ${risEscape(pmcid)}`);
  if (arxivId && !isArxivPrefix) lines.push(`N1  - arXiv ID: ${risEscape(arxivId)}`);

  // Attach the local PDF file (L1). Zotero converts this to a linked file
  // attachment on import. When the user has set their absolute Downloads
  // path in settings, we emit a fully-resolved file:// URL so Zotero finds
  // the file without any extra configuration. Otherwise we emit the relative
  // path, which works if the user has set Zotero's Linked Attachment Base
  // Directory.
  if (result.filename) {
    lines.push(`L1  - ${risEscape(risFileUrl(result.filename, downloadsPath))}`);
    lines.push(`N1  - Downloaded by ICompletist via ${risEscape(result.source)}${result.via ? "/" + risEscape(result.via) : ""}`);
  }

  if (result.license) lines.push(`N1  - License: ${risEscape(result.license)}`);

  // For unavailable items, embed the manual-fallback URLs so the user can
  // click through to them from inside Zotero.
  if (Array.isArray(result.tryUrls) && result.tryUrls.length) {
    for (const u of result.tryUrls) {
      lines.push(`UR  - ${risEscape(u.url)}`);
    }
    const labels = result.tryUrls.map((u) => u.label).join(", ");
    lines.push(`N1  - ICompletist could not auto-download. Try: ${risEscape(labels)}`);
  }

  if (result.error) lines.push(`N1  - Error: ${risEscape(result.error)}`);

  lines.push("ER  - ");
  return lines.join("\r\n");
}

export function buildRis(run, { downloadsPath } = {}) {
  const entries = run.results.map((r) => entryFor(r, downloadsPath));
  return entries.join("\r\n\r\n") + "\r\n";
}
