# ICompletist

A browser extension that bulk-fetches scientific articles **legally**. Paste a list of identifiers, click Fetch, get PDFs.

Accepts DOIs, arXiv IDs, and OpenReview IDs in any mix. Tries a cascade of legitimate sources, downloads to a folder of your choice, exports the results as a Zotero-importable RIS file.

## What it does

For each identifier, ICompletist tries these sources in order until one succeeds:

1. **arXiv direct** (for arXiv IDs and `10.48550/arXiv.X` DOIs)
2. **bioRxiv / medRxiv** (for `10.1101/` DOIs) — via the bioRxiv API
3. **Semantic Scholar** — batch pre-pass for all DOIs at the start of a run (up to 500 per request)
4. **CORE** — aggregator of ~200M+ OA repository copies
5. **Publisher TDM APIs** — Elsevier ScienceDirect, Springer Nature, Wiley (when your institution has a TDM agreement)
6. **Unpaywall** — finds OA copies across publishers and repositories
7. **PMC** — PubMed Central full text via Europe PMC + NCBI
8. **IEEE Open Access API** — for `10.1109/` DOIs marked as OA
9. **Institutional link resolver** — your library's OpenURL endpoint, using your own browser session

If nothing succeeds, the result is `unavailable` and includes a list of URLs the user can open manually (Unpaywall's full set of OA locations, PMC article page, bioRxiv landing page, DOI resolver, institutional link, etc.).

## Architecture highlights

- **Parallel worker pool** (5 concurrent DOIs) with per-domain throttling so we never hammer one publisher
- **Magic-byte PDF validation** — every download is verified to actually start with `%PDF-`, so HTML stubs (PMC preprint pages, Cloudflare blocks, login walls) never get saved with a `.pdf` extension
- **Run history** persisted in `chrome.storage.local`, last 10 runs accessible from the dropdown, with per-run RIS export
- **Tab mode** (`⇱` button) for long batches — service workers can die when popups close, the tab stays alive
- **Failure fallback URLs** carried through to history and RIS export

## Install

1. Unzip somewhere permanent
2. `chrome://extensions` (or `brave://extensions`, `edge://extensions`)
3. Turn on **Developer mode**
4. Click **Load unpacked** → pick the `icompletist` folder
5. Pin the icon to your toolbar

## Configure

Click the ⚙ button in the popup header. The only required field is **Email** (used by Unpaywall and PMC to identify you — standard etiquette, not authentication). Everything else is optional but each one adds capability:

| Field | What it unlocks |
| --- | --- |
| Email | Unpaywall, PMC |
| NCBI API key | Raises PMC rate limit from 3/sec to 10/sec |
| Semantic Scholar API key | Removes shared-pool rate limits on the batch pre-pass |
| CORE API key | The CORE step |
| Downloads folder absolute path | `file://` URLs in RIS export (Zotero finds files automatically on import) |
| OpenURL resolver | Institutional resolver step |
| Elsevier API key (+ optional Inst. Token) | Elsevier TDM step |
| Springer API key | Springer TDM step |
| Wiley TDM token | Wiley TDM step |
| IEEE API key | IEEE OA step |

## Use

1. Paste identifiers into the textarea — one per line, comma-separated, or pasted from messy text. The regex picks them out.
2. Optionally adjust the **subfolder** (default `icompletist/` under your Downloads directory)
3. Click **Fetch articles**
4. Watch progress; PDFs save automatically
5. When done, the run appears in **Recent runs** — pick it from the dropdown to review results
6. Click **Export RIS (for Zotero)** to get a `.ris` file you can import into Zotero with one click

## Zotero workflow

1. In ICompletist settings, set your absolute Downloads path (e.g. `/home/you/Downloads`)
2. Run a batch
3. Click **Export RIS (for Zotero)**
4. In Zotero: **File → Import…** → pick the `.ris` → check "Place imported items into new collection"
5. Each entry imports with:
   - Title/authors/journal/year auto-fetched by Zotero from the DOI
   - The downloaded PDF linked as an attachment
   - For unavailable items, clickable URLs to try manually

## What this tool will not do

- It does **not** bypass paywalls. If your institution doesn't license a paper and no OA copy exists, the result is `unavailable`.
- It does **not** share or pool credentials between users.
- It does **not** access any content you don't already have a personal right to read.
- It does **not** scrape `files.core.ac.uk` URLs directly (per CORE's terms).
