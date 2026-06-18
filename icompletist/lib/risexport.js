// lib/risexport.js - Build a RIS file from a run's results.
//
// Why RIS instead of BibTeX or CSL-JSON: it's the format Zotero, Mendeley,
// EndNote, and Papers all import cleanly, and it has a well-defined "file
// attachment" tag (L1) that lets us point at the PDF we downloaded.
//
// Why we keep entries minimal: we usually only have the identifier and
// (sometimes) a title. Zotero will automatically fill in authors, journal,
// year, abstract, etc. from the DOI via its built-in DOI lookup. So we
// deliberately leave those blank — better than guessing.
//
// RIS reference for the tags we use:
//   TY  - Type of reference (JOUR = journal article, GEN = generic)
//   T1  - Primary title
//   DO  - DOI
//   UR  - URL (one per tag, repeatable)
//   L1  - File attachment (local file path)
//   N1  - Notes
//   ER  - End of reference (required)
//
// Docs: https://en.wikipedia.org/wiki/RIS_(file_format)

function risEscape(value) {
  if (value == null) return "";
  // RIS uses CRLF line endings and doesn't support multi-line values for most
  // tags. Collapse whitespace and strip newlines.
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

// Convert an arbitrary OS path (POSIX or Windows) plus a relative filename
// inside it into a fully-formed file:// URL, the kind Zotero will resolve as
// a real file on disk.
//
// Examples:
//   ("/home/alice/Downloads", "icompletist/foo.pdf")
//     -> "file:///home/alice/Downloads/icompletist/foo.pdf"
//   ("C:\\Users\\Alice\\Downloads", "icompletist/foo.pdf")
//     -> "file:///C:/Users/Alice/Downloads/icompletist/foo.pdf"
function buildFileUrl(basePath, relPath) {
  if (!basePath) return null;
  // Normalize: backslashes -> forward, strip surrounding quotes, drop trailing slash.
  let base = String(basePath).trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  // URL-encode each path segment but preserve the slashes and the leading drive
  // letter (e.g. "C:") so the result is valid as a file:// URL.
  const encodeSegments = (p) => p.split("/").map((seg) => {
    // Don't touch a Windows drive letter like "C:".
    if (/^[A-Za-z]:$/.test(seg)) return seg;
    return encodeURIComponent(seg);
  }).join("/");
  const baseEncoded = encodeSegments(base);
  const relEncoded = encodeSegments(String(relPath).replace(/\\/g, "/"));
  // Prepend the file:// scheme. POSIX absolute paths start with "/", so we get
  // "file:///home/..."; Windows paths begin with a drive letter so we get
  // "file:///C:/Users/...".
  const prefix = baseEncoded.startsWith("/") ? "file://" : "file:///";
  return `${prefix}${baseEncoded}/${relEncoded}`;
}

function entryFor(result, downloadsPath) {
  const lines = [];
  const isDoi = !result.doi.startsWith("arxiv:") && !result.doi.startsWith("openreview:");
  const isArxiv = result.doi.startsWith("arxiv:");
  const isOpenReview = result.doi.startsWith("openreview:");

  lines.push("TY  - JOUR");

  if (result.title) lines.push(`T1  - ${risEscape(result.title)}`);

  if (isDoi) {
    lines.push(`DO  - ${risEscape(result.doi)}`);
    lines.push(`UR  - https://doi.org/${risEscape(result.doi)}`);
  } else if (isArxiv) {
    const id = result.doi.replace(/^arxiv:/i, "");
    lines.push(`UR  - https://arxiv.org/abs/${risEscape(id)}`);
    lines.push(`N1  - arXiv ID: ${risEscape(id)}`);
  } else if (isOpenReview) {
    const id = result.doi.replace(/^openreview:/i, "");
    lines.push(`UR  - https://openreview.net/forum?id=${risEscape(id)}`);
    lines.push(`N1  - OpenReview ID: ${risEscape(id)}`);
  }

  // Attach the local PDF file (L1). Zotero converts this to a linked file
  // attachment on import. When the user has set their absolute Downloads
  // path in settings, we emit a fully-resolved file:// URL so Zotero finds
  // the file without any extra configuration. Otherwise we emit the relative
  // path, which works if the user has set Zotero's Linked Attachment Base
  // Directory.
  if (result.filename) {
    const absolute = buildFileUrl(downloadsPath, result.filename);
    lines.push(`L1  - ${risEscape(absolute || result.filename)}`);
    lines.push(`N1  - Downloaded by ICompletist via ${risEscape(result.source)}${result.via ? "/" + risEscape(result.via) : ""}`);
  }

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
