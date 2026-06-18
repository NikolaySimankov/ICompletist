// lib/pdfcheck.js - Verify that a Blob is actually a PDF, not HTML masquerading
// as one.
//
// Why this matters: many servers (PMC preprint stubs, publisher landing pages,
// Sci-Hub-style proxies, error pages) return HTML responses even when the URL
// suggests a PDF. The MIME type alone isn't enough — some servers mislabel
// content. The size alone isn't enough either — an HTML error page can easily
// be 30KB.
//
// The reliable check: every PDF file starts with the magic bytes "%PDF-".
// Read the first 8 bytes of the blob and check.

export async function isPdfBlob(blob) {
  if (!blob || blob.size < 100) return false; // Too small to be a real PDF.

  // Read first 8 bytes and check for the %PDF- magic.
  const head = await blob.slice(0, 8).arrayBuffer();
  const bytes = new Uint8Array(head);
  // %PDF- = 0x25 0x50 0x44 0x46 0x2D
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
}

// Convenience: return a quick description of what the blob actually looks like,
// for debug logging.
export async function describeBlob(blob) {
  if (!blob) return "no blob";
  const head = await blob.slice(0, 16).arrayBuffer();
  const bytes = new Uint8Array(head);
  const ascii = String.fromCharCode(...bytes).replace(/[^\x20-\x7e]/g, ".");
  return `type=${blob.type || "unknown"} size=${blob.size} head="${ascii}"`;
}
