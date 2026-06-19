// lib/wikidata.js - Common-name / synonym lookup via Wikidata.
//
// Ported from get_common_names_from_wikidata() in the Python ICompletist.
// Two keyless steps:
//   1. wbsearchentities → resolve the term to the top-matching entity (Qid)
//   2. Special:EntityData/{Qid}.json → read the English label + aliases
//
// Returns the common names (label first, then up to 5 aliases), de-duplicated
// case-insensitively. The caller decides whether to prepend the original term.
//
// No API key required. Wikidata asks browser clients to identify themselves
// via the Api-User-Agent header (the User-Agent header itself is forbidden to
// set from fetch); we pass the configured email when available.

export async function commonNamesFromWikidata(scientificName, email) {
  const term = (scientificName || "").trim();
  if (!term) return [];

  const headers = email ? { "Api-User-Agent": `ICompletist (${email})` } : {};

  // 1. Resolve the term to an entity id.
  const searchUrl = "https://www.wikidata.org/w/api.php?" + new URLSearchParams({
    action: "wbsearchentities",
    search: term,
    language: "en",
    format: "json",
  });
  const sRes = await fetch(searchUrl, { headers });
  if (!sRes.ok) throw new Error(`Wikidata search ${sRes.status}`);
  const sData = await sRes.json();
  const first = sData.search && sData.search[0];
  if (!first) return [];

  // 2. Fetch the entity's label + aliases.
  const entityUrl = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(first.id)}.json`;
  const eRes = await fetch(entityUrl, { headers });
  if (!eRes.ok) throw new Error(`Wikidata entity ${eRes.status}`);
  const eData = await eRes.json();
  const entity = eData.entities && eData.entities[first.id];
  if (!entity) return [];

  const label = entity.labels?.en?.value || null;
  const aliases = (entity.aliases?.en || []).map((a) => a.value).slice(0, 5);

  const out = [];
  const seen = new Set();
  for (const n of [label, ...aliases]) {
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}
