# ICompletist

A browser extension that bulk-fetches scientific articles **legally**, by trying these sources in order:

1. **PubMed Central (PMC)** — free full text of millions of biomedical articles via NCBI E-utilities + Europe PMC. No key needed.
2. **Unpaywall** — free legal OA copies across all fields (preprints, repository deposits, gold OA).
3. **Publisher TDM APIs** — Elsevier ScienceDirect, Springer Nature. Use your institution's subscription via the official text-and-data-mining endpoints designed for bulk access.
4. **Institutional link resolver** — OpenURL fallback that uses **your own browser session** (cookies/IP), so the publisher sees normal authenticated traffic.

If none of these succeed for a given DOI, the article is reported as unavailable.

## Why this design is sustainable

- **No credential sharing.** The extension runs in your browser, uses your session. Nothing is sent to a central server.
- **TDM APIs are designed for this.** They allow bulk programmatic access without triggering abuse systems, as long as you stay within your institution's subscription.
- **Throttled by default.** 6-second gap between same-publisher requests. Bulk runs are slow on purpose — fast scraping is what gets institutions cut off.
- **Unpaywall first.** Roughly half of recent paywalled papers have a legal OA copy somewhere; fetching from a repository is faster and doesn't touch publisher quotas.

## Install (developer mode)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and select this folder.
4. Click the extension icon, then the ⚙ button to open Settings.

## Configure

| Field | Required? | What it does |
| --- | --- | --- |
| Email | Yes | Sent to Unpaywall and NCBI to identify you. Standard etiquette, not authentication. |
| NCBI API key | Optional | Raises PMC limit from 3/sec to 10/sec. Free at ncbi.nlm.nih.gov/account. |
| OpenURL resolver | Recommended | Your library's link resolver base URL. Ask your librarian. |
| Elsevier API key | Optional | Get one at https://dev.elsevier.com/. |
| Elsevier Inst. Token | Optional | Needed for off-campus Elsevier TDM access. |
| Springer API key | Optional | Get one at https://dev.springernature.com/. |

## Usage

1. Paste a list of DOIs into the textarea (one per line, or pasted from any text — DOIs are auto-extracted).
2. Click **Fetch articles**.
3. Watch progress; PDFs are saved to your default Downloads folder under `icompletist/`.
4. The results panel shows which source each article came from.

## What this does not do

- It does **not** bypass paywalls. If your institution doesn't license a paper and no OA copy exists, you get "unavailable."
- It does **not** share or pool credentials between users.
- It does **not** automate access for someone who lacks their own legitimate access path.

## Extending

- Add a new publisher TDM integration: drop a module in `lib/`, follow the shape of `elsevier.js`, then wire it into `background.js → processDoi`.
- For Wiley TDM, the pattern is similar: see https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining
- For institutional proxies (EZproxy), the resolver URL pattern often just needs a `?url=` wrapper around the publisher URL. Configure that in the resolver base.

## Legal note

This tool is designed to operate within the terms of service of major publishers and within the licensing scope your institution holds. It does not enable access to content you do not personally have a license to read. If your institution's terms forbid programmatic access via the official TDM APIs (uncommon, but possible), don't use those modes.
