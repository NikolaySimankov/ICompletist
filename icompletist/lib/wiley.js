// lib/wiley.js - Wiley Online Library TDM API.
//
// Endpoint:   GET https://api.wiley.com/onlinelibrary/tdm/v1/articles/{doi}
// Auth:       Wiley-TDM-Client-Token header
// Access:     Token authenticates you, but the *actual* content access is
//             determined by your IP address (your institution must be a Wiley
//             subscriber and your request must originate from a recognized IP).
//
// Get a token: https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining
// (Requires a Wiley Online Library account.)
//
// Rate limit: Wiley asks for ≤1 req/sec. We throttle 6s/publisher already in
// background.js, which is well within their limit.
//
// Note: Wiley redirects to a signed S3 URL for the PDF. fetch() with default
// redirect:'follow' handles this transparently in a service worker.

export async function wileyTdmFetch(doi, { token } = {}) {
  if (!token) throw new Error("Wiley TDM token not configured.");

  const url = `https://api.wiley.com/onlinelibrary/tdm/v1/articles/${encodeURIComponent(doi)}`;
  const res = await fetch(url, {
    headers: { "Wiley-TDM-Client-Token": token },
    redirect: "follow",
  });

  if (!res.ok) {
    let reason = "";
    try { reason = await res.text(); } catch { /* ignore */ }
    return { found: false, status: res.status, reason };
  }

  const blob = await res.blob();
  if (!blob.type.includes("pdf") && blob.size < 5000) {
    return { found: false, status: res.status, reason: "Response was not a PDF" };
  }
  return { found: true, blob };
}
