// lib/search/pubmed.js - PubMed E-utilities search adapter.
//
// API: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
//   esearch.fcgi   → list of PMIDs
//   esummary.fcgi  → light metadata for each PMID (we use this, not efetch,
//                    because we want to be FAST in the search stage; efetch
//                    is for the abstract-enrichment stage that comes later)
// Email is sent as a query param to identify the caller (NCBI etiquette).
// An API key (free) raises the rate limit from 3/sec to 10/sec.

const FIELD_MAP = {
  "title": "[Title]",
  "title-abs": "[Title/Abstract]",
  "title-abs-keywords": "[Title/Abstract]", // PubMed has no "keywords" field
  "all": "[All Fields]",
};

const DOCTYPE_MAP = {
  "article": "Journal Article[ptyp]",
  "review": "Review[ptyp]",
  "clinical-trial": "Clinical Trial[ptyp]",
  "meta-analysis": "Meta-Analysis[ptyp]",
};

export function buildQuery(spec) {
  const field = FIELD_MAP[spec.field] || "[Title/Abstract]";
  const groups = spec.groups || [];
  if (!groups.length) return "";

  const renderGroup = (g) => {
    const op = g.internal || "OR";
    const tagged = g.terms.map((t) => `"${t}"${field}`);
    return "(" + tagged.join(` ${op} `) + ")";
  };

  let q = renderGroup(groups[0]);
  for (const g of groups.slice(1)) {
    const ext = (g.external || "AND").replace("AND NOT", "NOT");
    q = `${q} ${ext} ${renderGroup(g)}`;
  }

  if (spec.yearFrom || spec.yearTo) {
    const start = spec.yearFrom ? `${spec.yearFrom}/1/1` : "1000/1/1";
    const end = spec.yearTo ? `${spec.yearTo}/12/31` : "3000/12/31";
    q += ` AND (${start}:${end}[pdat])`;
  }

  if (Array.isArray(spec.doctype) && spec.doctype.length) {
    const expr = spec.doctype.map((d) => DOCTYPE_MAP[d]).filter(Boolean).join(" OR ");
    if (expr) q += ` AND (${expr})`;
  }

  return q;
}

export async function search(query, { email, apiKey, limit = 1000, onProgress } = {}) {
  const items = [];
  const batchSize = 200; // ESummary handles up to 200 PMIDs at a time.

  // Step 1: ESearch — get PMID list.
  const esearchParams = new URLSearchParams({
    db: "pubmed",
    term: query,
    retmax: String(Math.min(limit, 10000)),
    retmode: "json",
  });
  if (email) esearchParams.set("email", email);
  if (apiKey) esearchParams.set("api_key", apiKey);

  const esearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${esearchParams}`;
  const esearchRes = await fetch(esearchUrl);
  if (!esearchRes.ok) throw new Error(`PubMed ESearch ${esearchRes.status}`);
  const esearchData = await esearchRes.json();
  const pmids = esearchData.esearchresult?.idlist || [];
  const total = parseInt(esearchData.esearchresult?.count, 10) || pmids.length;

  if (!pmids.length) return { items: [], total: 0, source: "pubmed" };

  // Step 2: ESummary in batches.
  for (let i = 0; i < pmids.length; i += batchSize) {
    const batch = pmids.slice(i, i + batchSize);
    const sumParams = new URLSearchParams({
      db: "pubmed",
      id: batch.join(","),
      retmode: "json",
    });
    if (email) sumParams.set("email", email);
    if (apiKey) sumParams.set("api_key", apiKey);

    const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${sumParams}`;
    const sumRes = await fetch(sumUrl);
    if (!sumRes.ok) continue;
    const sumData = await sumRes.json();
    const result = sumData.result || {};
    for (const pmid of batch) {
      const rec = result[pmid];
      if (!rec || rec.error) continue;
      // Pull DOI out of the articleids list.
      const articleIds = rec.articleids || [];
      const doiEntry = articleIds.find((a) => a.idtype === "doi");
      const pmcEntry = articleIds.find((a) => a.idtype === "pmc");
      const year = rec.pubdate ? parseInt(rec.pubdate.slice(0, 4), 10) : null;
      items.push({
        source: "pubmed",
        pmid,
        pmcid: pmcEntry ? pmcEntry.value.replace(/^PMC/i, "") : null,
        doi: doiEntry ? doiEntry.value.toLowerCase() : null,
        title: rec.title || null,
        authors: (rec.authors || []).map((a) => a.name).filter(Boolean),
        year: isNaN(year) ? null : year,
        journal: rec.fulljournalname || rec.source || null,
        volume: rec.volume || null,
        pages: rec.pages || null,
        sourceUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      });
    }
    if (onProgress) onProgress({ done: items.length, total });
    // Light pacing — NCBI's limit is 3/sec without a key, 10/sec with one.
    await new Promise((r) => setTimeout(r, apiKey ? 120 : 350));
  }

  return { items, total, source: "pubmed" };
}
