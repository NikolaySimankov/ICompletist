// lib/openalex.js - Free legal OA lookup via OpenAlex.
//
// OpenAlex (https://openalex.org) is a large open scholarly index that often
// has fresh OA PDF locations Unpaywall hasn't surfaced yet. No key required;
// they ask you to identify yourself via the `mailto` param (the "polite
// pool"). Ported from _oa_pdf_urls_openalex() in the Python get_pdf.py.
//
// Returns:
//   { found, pdfUrl, candidateUrls, landingUrls, title, license }
// where candidateUrls is every OA PDF URL OpenAlex reports (best first) and
// landingUrls are the article landing pages (used as manual-fallback links and
// as inputs to the citation_pdf_url scraper).

export async function openalexLookup(doi, email) {
  const base = `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}`;
  const url = email ? `${base}?mailto=${encodeURIComponent(email)}` : base;

  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return { found: false, candidateUrls: [], landingUrls: [] };
    throw new Error(`OpenAlex ${res.status}`);
  }
  const data = await res.json();

  const candidateUrls = [];
  const seenPdf = new Set();
  const pushPdf = (u) => { if (u && !seenPdf.has(u)) { seenPdf.add(u); candidateUrls.push(u); } };

  const landingUrls = [];
  const seenLanding = new Set();
  const pushLanding = (u) => { if (u && !seenLanding.has(u)) { seenLanding.add(u); landingUrls.push(u); } };

  // best_oa_location first, then primary_location, then every other location.
  const best = data.best_oa_location || data.primary_location || null;
  if (best) { pushPdf(best.pdf_url); pushLanding(best.landing_page_url); }
  for (const loc of Array.isArray(data.locations) ? data.locations : []) {
    pushPdf(loc.pdf_url);
    pushLanding(loc.landing_page_url);
  }

  const pdfUrl = candidateUrls[0] || null;
  return {
    found: !!pdfUrl,
    pdfUrl,
    candidateUrls,
    landingUrls,
    title: data.title || null,
    license: best?.license || null,
  };
}
