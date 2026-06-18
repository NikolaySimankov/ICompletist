// lib/unpaywall.js - Free legal OA lookup via Unpaywall.
// Docs: https://unpaywall.org/products/api
// Requires only an email address (no API key, no rate limit for reasonable use,
// but they ask you to identify yourself in case of abuse).

export async function unpaywallLookup(doi, email) {
  if (!email) throw new Error("Unpaywall requires an email address in settings.");
  const url = `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return { found: false };
    throw new Error(`Unpaywall ${res.status}`);
  }
  const data = await res.json();
  const best = data.best_oa_location;
  // Collect every OA location URL we got, deduplicated, in priority order:
  // best_oa_location first, then all oa_locations, then landing pages.
  const allLocations = Array.isArray(data.oa_locations) ? data.oa_locations : [];
  const candidateUrls = [];
  const seen = new Set();
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); candidateUrls.push(u); } };
  if (best?.url_for_pdf) push(best.url_for_pdf);
  for (const loc of allLocations) push(loc.url_for_pdf);
  if (best?.url) push(best.url);
  for (const loc of allLocations) push(loc.url);

  if (!best || !best.url_for_pdf) {
    return { found: false, candidateUrls, title: data.title, meta: data };
  }
  return {
    found: true,
    pdfUrl: best.url_for_pdf,
    candidateUrls,
    license: best.license,
    hostType: best.host_type, // 'publisher' or 'repository'
    title: data.title,
    meta: data,
  };
}
