// lib/resolver.js - OpenURL link resolver fallback.
//
// Most academic libraries expose an OpenURL endpoint (SFX, Alma, EZproxy, etc.)
// that, given a DOI, tells you whether the institution licenses the article and
// hands back a URL to fetch it through the institutional session.
//
// The user configures the base URL in settings, e.g.:
//   https://your-uni.libkey.io/libraries/123/openurl
//   https://sfx.your-uni.edu/your-uni
//
// This module returns the resolved URL. The actual fetch happens in the
// caller and uses the user's existing browser session (cookies) so the
// publisher sees a normal authenticated request.

export async function resolveOpenUrl(doi, resolverBase) {
  if (!resolverBase) return { found: false, reason: "No resolver configured" };
  const params = new URLSearchParams({
    "url_ver": "Z39.88-2004",
    "rft_id": `info:doi/${doi}`,
    "svc.fulltext": "yes",
  });
  const url = `${resolverBase}${resolverBase.includes("?") ? "&" : "?"}${params}`;
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!res.ok) return { found: false, status: res.status };
    // Most resolvers return HTML with a link or 302 to the full text.
    // The caller can navigate to res.url to land on the publisher's
    // authenticated session.
    return { found: true, url: res.url };
  } catch (e) {
    return { found: false, reason: e.message };
  }
}

// Helper: fetch a PDF through the user's browser session (uses their cookies,
// so publishers see normal authenticated traffic from the user's own IP).
export async function fetchWithSession(url) {
  const res = await fetch(url, { credentials: "include", redirect: "follow" });
  if (!res.ok) return { ok: false, status: res.status };
  const blob = await res.blob();
  if (!blob.type.includes("pdf")) return { ok: false, reason: "Response is not a PDF (login wall?)" };
  return { ok: true, blob };
}
