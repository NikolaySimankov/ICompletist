// lib/ieee_session.js - IEEE Xplore PDF via the user's own browser session.
//
// For subscription IEEE content, the OA API can't help. But when the user is
// authenticated to IEEE (on the university VPN / IP range, or signed in), the
// stamp page hands back the PDF — exactly as it does in their browser:
//
//   https://ieeexplore.ieee.org/document/{arnumber}   ← article page
//   https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber={arnumber}
//       └─ returns an HTML viewer whose iframe/frame src is the real PDF
//          (…/ielx*/…/{arnumber}.pdf or a stampPDF/getPDF.jsp link)
//
// We fetch with credentials:"include" so the request carries the user's IEEE
// cookies, and (because the VPN routes the whole machine) it egresses from the
// institution's IP. This is the same legitimate access the user already has —
// no paywall bypass, no shared credentials.
//
// Limitations: IEEE may serve a bot/Cloudflare challenge to programmatic
// requests (fetch can't set User-Agent), in which case we fall back to handing
// the user the article URL to open manually.

import { isPdfBlob, describeBlob } from "./pdfcheck.js";
import { isIeeeDoi } from "./ieee.js";

const BASE = "https://ieeexplore.ieee.org";

// Resolve a 10.1109 DOI to its IEEE article number via the doi.org redirect.
async function arnumberFromDoi(doi) {
  try {
    const res = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
      redirect: "follow",
      credentials: "include",
    });
    const fromUrl = (res.url || "").match(/ieeexplore\.ieee\.org\/document\/(\d+)/i);
    if (fromUrl) return fromUrl[1];
    const html = await res.text().catch(() => "");
    const fromHtml = html.match(/\/document\/(\d+)/);
    return fromHtml ? fromHtml[1] : null;
  } catch {
    return null;
  }
}

// Pull the real PDF URL out of the stamp.jsp HTML.
function pdfUrlFromStampHtml(html) {
  if (!html) return null;
  const re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (/\.pdf(\?|$)/i.test(u) || /getPDF\.jsp/i.test(u) || /\/ielx?\d/i.test(u)) {
      return u;
    }
  }
  return null;
}

export async function ieeeSessionFetch(doi, { arnumber } = {}) {
  if (!arnumber && !isIeeeDoi(doi)) return { found: false, reason: "Not an IEEE DOI" };
  const ar = arnumber || (await arnumberFromDoi(doi));
  if (!ar) return { found: false, reason: "Could not resolve IEEE article number" };

  const articleUrl = `${BASE}/document/${ar}`;
  const stampUrl = `${BASE}/stamp/stamp.jsp?tp=&arnumber=${encodeURIComponent(ar)}`;

  let res;
  try {
    res = await fetch(stampUrl, {
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "text/html,application/pdf,*/*;q=0.8", Referer: articleUrl },
    });
  } catch (e) {
    return { found: false, reason: `stamp fetch error: ${e.message}`, articleUrl };
  }
  if (!res.ok) return { found: false, reason: `stamp returned ${res.status}`, articleUrl };

  // Some configurations stream the PDF straight from stamp.jsp.
  if (/pdf/i.test(res.headers.get("content-type") || "")) {
    const blob = await res.blob();
    if (await isPdfBlob(blob)) return { found: true, blob, arnumber: ar, via: "stamp" };
  }

  const html = await res.text().catch(() => "");
  let pdfUrl = pdfUrlFromStampHtml(html);
  if (!pdfUrl) {
    return { found: false, reason: "No PDF URL in stamp page (not authenticated / challenged?)", articleUrl };
  }
  try { pdfUrl = new URL(pdfUrl, BASE).href; } catch { /* keep as-is */ }

  let pres;
  try {
    pres = await fetch(pdfUrl, {
      credentials: "include",
      redirect: "follow",
      headers: { Accept: "application/pdf,*/*;q=0.8", Referer: stampUrl },
    });
  } catch (e) {
    return { found: false, reason: `pdf fetch error: ${e.message}`, articleUrl };
  }
  if (!pres.ok) return { found: false, reason: `pdf returned ${pres.status}`, articleUrl };

  const blob = await pres.blob();
  if (await isPdfBlob(blob)) return { found: true, blob, arnumber: ar, via: "stamp-pdf" };
  return { found: false, reason: `Response was not a PDF (${await describeBlob(blob)})`, articleUrl };
}
