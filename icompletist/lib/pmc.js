// lib/pmc.js - PubMed Central full-text fetcher via NCBI E-utilities.
//
// PMC hosts free full text of millions of biomedical articles. Many are
// deposited under NIH public access policy. No API key required, but NCBI
// asks you to identify yourself via tool/email params and limits unauthenticated
// requests to 3/sec. With an API key (https://www.ncbi.nlm.nih.gov/account/),
// the limit goes up to 10/sec.
//
// Two-step flow:
//   1. ID conversion: DOI -> PMCID via idconv.ncbi.nlm.nih.gov
//   2. Fetch PDF from europepmc.org (more reliable PDF delivery than PMC itself)
//      or fall back to the NCBI PMC article page.
//
// Docs:
//   https://www.ncbi.nlm.nih.gov/pmc/tools/id-converter-api/
//   https://europepmc.org/RestfulWebService

const TOOL_NAME = "icompletist";

export async function pmcLookup(doi, { email, apiKey } = {}) {
  // Step 1: DOI -> PMCID
  const params = new URLSearchParams({
    ids: doi,
    format: "json",
    tool: TOOL_NAME,
  });
  if (email) params.set("email", email);
  if (apiKey) params.set("api_key", apiKey);

  const convUrl = `https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?${params}`;
  const convRes = await fetch(convUrl);
  if (!convRes.ok) return { found: false, status: convRes.status };

  const conv = await convRes.json();
  const record = conv.records?.[0];
  const pmcid = record?.pmcid;
  if (!pmcid) return { found: false, reason: "Not in PMC" };

  // Some PMC records have an embargo or are author-manuscript-only.
  if (record.live === "false" || record.status === "error") {
    return { found: false, reason: "PMC record not yet live (embargoed)" };
  }

  // Step 2: Fetch PDF. Europe PMC's direct PDF URL is the most reliable.
  // Pattern: https://europepmc.org/articles/PMC1234567?pdf=render
  const pdfUrl = `https://europepmc.org/articles/${pmcid}?pdf=render`;
  const pdfRes = await fetch(pdfUrl, { redirect: "follow" });

  if (pdfRes.ok) {
    const blob = await pdfRes.blob();
    if (blob.type.includes("pdf") || blob.size > 10000) {
      return { found: true, blob, pmcid, source: "europepmc" };
    }
  }

  // Fallback: NCBI PMC direct PDF link (pattern varies; this is current as of 2024+).
  const ncbiPdfUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/`;
  const ncbiRes = await fetch(ncbiPdfUrl, { redirect: "follow" });
  if (ncbiRes.ok) {
    const blob = await ncbiRes.blob();
    if (blob.type.includes("pdf") || blob.size > 10000) {
      return { found: true, blob, pmcid, source: "ncbi-pmc" };
    }
  }

  return { found: false, pmcid, reason: "PMCID found but PDF not retrievable" };
}
