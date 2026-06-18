// lib/pmc.js - PubMed Central full-text fetcher.
//
// Two-step flow:
//   1. ID conversion: DOI -> PMCID via idconv.ncbi.nlm.nih.gov
//   2. Fetch PDF from europepmc.org (preferred) or NCBI PMC.
//
// IMPORTANT: bioRxiv/medRxiv DOIs (10.1101/...) often resolve to a PMC record
// via the NIH preprint pilot. These records are STUBS — they have a PMCID but
// no real PDF; the URL returns an HTML "this is a preprint, see bioRxiv" page.
// We detect this early and refuse, so the pipeline falls through to the
// bioRxiv module which has the actual PDF.

import { isPdfBlob, describeBlob } from "./pdfcheck.js";

const TOOL_NAME = "icompletist";

export async function pmcLookup(doi, { email, apiKey } = {}) {
  // bioRxiv/medRxiv preprints have PMC stubs, not real PMC PDFs. Skip here so
  // the bioRxiv module handles them.
  if (/^10\.1101\//i.test(doi)) {
    return { found: false, reason: "bioRxiv/medRxiv DOI — handled by bioRxiv module" };
  }

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

  if (record.live === "false" || record.status === "error") {
    return { found: false, reason: "PMC record not yet live (embargoed)" };
  }

  // Try Europe PMC first.
  const europePdfUrl = `https://europepmc.org/articles/${pmcid}?pdf=render`;
  try {
    const res = await fetch(europePdfUrl, { redirect: "follow" });
    if (res.ok) {
      const blob = await res.blob();
      if (await isPdfBlob(blob)) {
        return { found: true, blob, pmcid, source: "europepmc" };
      }
      console.info(`PMC: europepmc returned non-PDF for ${pmcid}`, await describeBlob(blob));
    }
  } catch (e) {
    console.warn("PMC europepmc fetch error:", e);
  }

  // Fallback to NCBI PMC.
  const ncbiPdfUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/pdf/`;
  try {
    const res = await fetch(ncbiPdfUrl, { redirect: "follow" });
    if (res.ok) {
      const blob = await res.blob();
      if (await isPdfBlob(blob)) {
        return { found: true, blob, pmcid, source: "ncbi-pmc" };
      }
      console.info(`PMC: ncbi-pmc returned non-PDF for ${pmcid}`, await describeBlob(blob));
    }
  } catch (e) {
    console.warn("PMC ncbi fetch error:", e);
  }

  return { found: false, pmcid, reason: "PMCID found but PDF not retrievable (likely preprint stub or embargoed)" };
}
