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
  if (!best || !best.url_for_pdf) return { found: false, meta: data };
  return {
    found: true,
    pdfUrl: best.url_for_pdf,
    license: best.license,
    hostType: best.host_type, // 'publisher' or 'repository'
    title: data.title,
    meta: data,
  };
}
