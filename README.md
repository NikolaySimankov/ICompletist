# ICompletist

A browser extension that searches for and bulk-fetches scientific articles **legally**. Search several databases with one boolean query, or paste a list of identifiers, click Fetch, and get PDFs (or plain text for text mining).

The popup has three modes:

- **Fetch by ID** — paste DOIs, arXiv IDs, OpenReview IDs or article URLs in any mix. ICompletist tries a cascade of legitimate sources, downloads to a folder of your choice, and exports the results as a Zotero-importable RIS file.
- **Search by query** — run one boolean query across PubMed, Semantic Scholar, CORE, Scopus and IEEE Xplore, deduplicate, enrich and filter the hits, then hand them to the fetch pipeline.
- **PDF → TXT** — convert PDFs you already have into `.txt` files, locally.

## Fetch by ID

### Accepted input

Paste one identifier per line, comma-separated, or messy text — the parser picks them out:

- DOIs (`10.1038/nature12373`)
- arXiv IDs (`arXiv:2103.00020`)
- OpenReview IDs (`openreview.net/forum?id=…`)
- Article URLs. ICompletist finds the DOI for the page: from the URL path (doi.org, Frontiers, Wiley, …), via NCBI for PMC / PubMed links, via the Elsevier API for ScienceDirect links (needs an Elsevier key), or else from the page's `citation_doi` / `dc.identifier` / `prism.doi` meta tags.

### Source cascade

arXiv IDs and `10.48550/arXiv.X` DOIs go straight to **arXiv**, `10.1101/` DOIs to **bioRxiv / medRxiv**, and OpenReview IDs to **OpenReview**. Before the run starts, all DOIs are sent to **Semantic Scholar** in one batch (up to 500 per request) to collect known OA PDF URLs.

Every other DOI tries these sources in order until one returns a valid PDF:

1. **Publisher APIs** — only when the DOI belongs to that publisher *and* you configured the key, so other DOIs cost nothing here:
   - Elsevier ScienceDirect, Springer Nature and Wiley TDM APIs (needs an institutional TDM agreement)
   - IEEE Open Access API (`10.1109/` DOIs, needs an IEEE key)
   - **IEEE via your browser session** — see [IEEE subscription content](#ieee-subscription-content) below
2. **Semantic Scholar** — the OA URL from the batch pre-pass
3. **CORE** — aggregator of ~200M+ OA repository copies (needs a CORE key)
4. **Unpaywall** — OA copies across publishers and repositories (needs your email)
5. **OpenAlex** — another open OA index that often has fresh PDF locations Unpaywall hasn't picked up yet. No key; your email, if set, is sent as `mailto` for OpenAlex's polite pool. Every PDF location it reports is tried, best first.
6. **PMC** — PubMed Central full text via Europe PMC + NCBI
7. **Landing-page scrape** — reads the `citation_pdf_url` meta tag from the DOI landing page and up to two other landing pages found earlier (Frontiers, MDPI, PLOS, eLife, … all publish it)
8. **Institutional link resolver** — your library's OpenURL endpoint, using your own browser session

If nothing succeeds, the result is `unavailable` and lists URLs to try by hand: the DOI landing page, the IEEE Xplore article page, the best Unpaywall and OpenAlex locations, the PMC page, the resolver link, and so on. From the run view you can then attach a PDF you found yourself, either by picking a file or by pasting a direct PDF link. It is saved under ICompletist's naming scheme and included in the RIS export.

Every result with a DOI, fetched or not, is enriched with title, authors, year, journal, volume, pages, abstract and keywords from **Crossref**, so the RIS export is complete without Zotero having to look anything up.

### IEEE subscription content

The IEEE API only returns open-access PDFs. For subscription IEEE articles (`10.1109/` DOIs), ICompletist asks IEEE Xplore for the PDF the same way your browser does when you click "PDF" on an article page. No API key is needed.

- The request carries your own IEEE cookies and goes out from your own network.
- It only works if your browser already has access: on your institution's network or VPN, or signed in to IEEE Xplore.
- If IEEE serves a bot check or you are not authenticated, the item falls through to the rest of the cascade, and the IEEE article page is added to the "Try manually" links.

### Download format

The **Download as** menu applies to Fetch by ID runs and to "Download PDFs for this batch":

| Option | Result |
| --- | --- |
| PDF only | `.pdf` files |
| Text only | `.txt` files extracted with pdf.js, for text mining. If extraction fails for an article, the PDF is kept instead so nothing is lost. |
| PDF + Text | both, side by side |

## Search by query

### Query syntax

Write one group per line. The first line is the first group; every later line must start with `AND`, `OR`, `AND NOT` or `NOT` (treated as `AND NOT`). Inside a line, separate terms with `OR` (the default) or `AND`, but not both. Wrap phrases in double quotes. Lines starting with `#` are comments.

```
plant OR vegetation OR crop
AND pathogen OR disease OR pest
AND NOT wheat OR rice
```

ICompletist translates this into each database's own syntax (the generated per-database queries are logged to the extension's console).

### Expanding a term via Wikidata

Above the query box, type a scientific name (e.g. `Phytophthora infestans`) and click **Find common names**. ICompletist looks the term up on **Wikidata** and shows its English label plus up to five aliases as checkboxes. Untick any you don't want and click **Add as OR group to query**: the terms are added as a quoted OR group, joined to your existing query with `AND` (edit the operator if you meant something else). No key is needed.

### Filters

- **Year range** (from / to)
- **Match in** — Title + Abstract + Keywords, Title + Abstract, Title only, or All fields
- **Document type** — Article, Review, Conference, Book chapter (mapped to each database's closest equivalent)
- **Databases** — PubMed and Semantic Scholar are on by default. CORE, Scopus and IEEE Xplore need their API keys (Scopus uses the Elsevier key).
- **Per-source limit** — maximum hits taken from each database (default 500)

### Pipeline

Each search runs **SEARCH → DEDUPLICATE → ENRICH → ENSURE**:

1. **Search** all selected databases in parallel.
2. **Deduplicate** by DOI, then arXiv ID, PMID and other IDs, then normalized title. Each result records which databases returned it.
3. **Enrich** missing metadata (including abstracts) from Crossref. Existing data is never overwritten.
4. **Ensure** (on by default) re-checks every result locally against your query, using title + abstract + journal, and drops hits that don't actually contain your terms. Untick **ENSURE** to keep everything the databases returned.

The run is saved to history as soon as it starts. Open it from **Recent runs** to browse the results, export RIS, or click **Download PDFs for this batch** to send every result with a DOI or arXiv ID through the Fetch by ID cascade. **Recover this query** puts a past search's query, filters, databases and ENSURE setting back into the form.

## PDF → TXT

Pick one or more PDF files from your computer and click **Convert to TXT**. Each one is saved as a `.txt` with the same base name in the chosen Downloads subfolder. Text is extracted locally with pdf.js; nothing is uploaded and nothing is added to run history.

## Architecture highlights

- **Parallel worker pool** (5 articles at a time) with per-source throttling tuned to each API's published rate limits, so no publisher gets hammered
- **Magic-byte PDF validation** — every download is checked to actually start with `%PDF-`, so HTML stubs (PMC preprint pages, Cloudflare blocks, login walls) never get saved as `.pdf`
- **Offscreen pdf.js** — text extraction runs in a hidden offscreen document, because an MV3 service worker can't host pdf.js's worker
- **Run history** in `chrome.storage.local`: the last 10 runs, each with RIS export, re-fill, removal of unavailable items, and **Resume incomplete run** for batches interrupted midway
- **Already-downloaded check** — files already in the target subfolder are counted as cached instead of fetched again
- **Tab mode** (`⇱` button) for long batches — the popup can close and kill the service worker, the tab stays alive
- **Light / dark / auto theme** (`◐` button)

## Install

1. Unzip somewhere permanent
2. `chrome://extensions` (or `brave://extensions`, `edge://extensions`)
3. Turn on **Developer mode**
4. Click **Load unpacked** → pick the `icompletist` folder
5. Pin the icon to your toolbar

## Configure

Click the ⚙ button in the popup header. The only required field is **Email** (used by Unpaywall, NCBI, OpenAlex, Crossref and Wikidata to identify you — standard etiquette, not authentication). Everything else is optional, but each one adds capability:

| Field | What it unlocks |
| --- | --- |
| Email | Unpaywall, PMC; polite-pool access to OpenAlex and Crossref |
| NCBI API key | Raises PMC / PubMed rate limit from 3/sec to 10/sec |
| Semantic Scholar API key | Removes shared-pool rate limits on the batch pre-pass and S2 search |
| CORE API key | The CORE fetch step and CORE search |
| Downloads folder absolute path | `file://` URLs in RIS export (Zotero finds files automatically on import) |
| OpenURL resolver | Institutional resolver step |
| Elsevier API key (+ optional Inst. Token) | Elsevier TDM step, Scopus search, ScienceDirect URL → DOI |
| Springer API key | Springer TDM step |
| Wiley TDM token | Wiley TDM step |
| IEEE API key | IEEE OA step and IEEE Xplore search (subscription IEEE content uses your browser session and needs no key) |

OpenAlex and Wikidata need no keys.

**Export settings…** / **Import settings…** at the bottom of the settings page save all settings, including API keys, to a JSON file and restore them, e.g. on another machine. Keep that file private.

## Use

1. Choose a mode: **Fetch by ID**, **Search by query** or **PDF → TXT**
2. Optionally adjust the **subfolder** (default `icompletist/` under your Downloads directory) and **Download as**
3. Paste identifiers and click **Fetch articles**, or write a query and click **Run search**
4. Watch progress; files save automatically
5. When done, the run appears in **Recent runs** — pick it from the dropdown to review results
6. Click **Export RIS (for Zotero)** to get a `.ris` file you can import into Zotero with one click

## Zotero workflow

1. In ICompletist settings, set your absolute Downloads path (e.g. `/home/you/Downloads`)
2. Run a batch
3. Click **Export RIS (for Zotero)**
4. In Zotero: **File → Import…** → pick the `.ris` → check "Place imported items into new collection"
5. Each entry imports with:
   - Title, authors, journal, year, volume, pages, abstract and keywords (from Crossref and the search databases)
   - The downloaded PDF linked as an attachment
   - For unavailable items, clickable URLs to try manually

## What this tool will not do

- It does **not** bypass paywalls. If your institution doesn't license a paper and no OA copy exists, the result is `unavailable`.
- It does **not** share or pool credentials between users. The IEEE session step only uses the access your own browser already has.
- It does **not** access any content you don't already have a personal right to read.
- It does **not** scrape `files.core.ac.uk` URLs directly (per CORE's terms).

## Acknowledgments

- **Claude Code (Opus 5.5)** by [Anthropic](https://www.anthropic.com) — AI pair programming assistance for development of this project.
- **[PDF.js](https://mozilla.github.io/pdf.js/)** ([`pdfjs-dist`](https://www.npmjs.com/package/pdfjs-dist), v4.7.76) by Mozilla — used for the PDF→text extraction behind the "Text only" / "PDF + Text" download options and the PDF → TXT converter. Licensed under [Apache-2.0](https://github.com/mozilla/pdf.js/blob/master/LICENSE).
- **[OpenAlex](https://openalex.org)**, **[Wikidata](https://www.wikidata.org)** and **[Crossref](https://www.crossref.org)** for open scholarly metadata.
