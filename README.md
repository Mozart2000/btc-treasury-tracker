# Bitcoin Treasury Tracker

Static site (`site/`) + data script (`scripts/update.mjs`) + GitHub Actions workflow that refreshes `site/data.json` every ~15 min and deploys to GitHub Pages. No API keys, no dependencies.

## Add a company
Append an entry to `config/companies.json` (see `_readme` there). If CEBE Tracker covers it, set `cebeTicker`; otherwise fill `manual` with btc_holdings, debt_usd, preferred_usd, cash_usd, basic_shares, as_of, source from the latest filing.

`filings` turns on a freshness check. The figures stay on the CEBE or manual values.

- `{"source":"sec","cik":"0001050446"}` records the latest 8-K, 8-K/A, 10-Q, 10-Q/A, 10-K, or 10-K/A from EDGAR, and the page links to that filing. The script checks the CIK on EDGAR (the company-ticker list when that file is reachable, and the submissions record’s CIK and tickers) and skips the filing if they do not match. Optional `ticker` overrides `ticker` when the EDGAR symbol differs from the display ticker. A legacy `sec_cik` (and optional `sec_ticker`) still selects this check.
- `{"source":"metaplanet","url":"https://metaplanet.jp/en/shareholders/disclosures"}` reads Metaplanet’s TDnet disclosure list. Metaplanet does not file with the SEC. `url` is optional and defaults to that page (`source` may also be `"tdnet"`). The page redirects to `/en/disclosures`.

CEBE feed tickers today: MSTR, MTPLF, ASST, TSWCF, ALCPB, OBTC3, SVIA, NAKA, DDC, HOGPF, XXI, CASH3.

## Run locally
    node scripts/update.mjs && npx serve site   # or: python3 -m http.server -d site
    node --test                                  # filing-date comparison and disclosure parsing, no network

## Deploy (GitHub Pages)
1. Create a public GitHub repo, push this folder to `main`.
2. Repo Settings → Pages → Source: **GitHub Actions**.
3. Actions tab → run "Update data & deploy" once. Site: https://<user>.github.io/<repo>/
The workflow rewrites `style.css` and `app.js` in the deployed `index.html` with a content hash (`?v=`), so a browser that cached the previous script cannot render a newer page. `app.js` loads `data.json` with a unique query and `cache: 'no-store'`.
Note: GitHub disables scheduled workflows in public repos after 60 days with no repo activity; push any commit (or re-enable in the Actions tab) to resume.

## Data sources
- Balance sheet (BTC held, debt, preferred, cash, basic shares) + CEBE construction: CEBE Tracker open feed https://cebetracker.io/api/v1/companies.json — free with attribution ("Data via CEBE Tracker, cebetracker.io"), which the page displays.
- Stock prices & FX: Yahoo Finance chart endpoint (unofficial, keyless).
- BTC price: CoinGecko simple price (falls back to Yahoo BTC-USD).
- Latest filing is a freshness check. CEBE numbers are never replaced with values parsed from a filing.
  - SEC (`filings.source` `"sec"`, or legacy `sec_cik`): EDGAR submissions, `https://data.sec.gov/submissions/CIK##########.json`. The page shows the latest 8-K, 8-K/A, 10-Q, 10-Q/A, 10-K, or 10-K/A (form, date, sec.gov link). It shows “Up to date” when that filing is not newer than the date CEBE’s figures are based on, and a note such as “New 8-K filed Oct 22 — data may not reflect it yet” when it is. The comparison uses the accession number when CEBE’s source cites that filing, otherwise the latest date written in the source, otherwise the as-of date.
  - Metaplanet (`filings.source` `"metaplanet"`): the disclosure list at https://metaplanet.jp/en/shareholders/disclosures (Japanese twin under `/ja/disclosures`). A plain GET returns a server-rendered page. The update reads the embedded disclosures payload (date, title, PDF link). The HTML table is only the first page and does not include the PDF hrefs. Each row is an English or Japanese copy of a TDnet filing. The English list is what the cell counts; a later date that exists only in Japanese still flags. The cell shows the newest disclosure (English title when one is on that date), linked to the PDF on contents.xj-storage.jp or metaplanet.jp, and how many newer disclosures there are. Titles that look like a bitcoin purchase, convertible bond, share issuance, share repurchase, or preferred stock are called out in the note and the shown title is highlighted. The company is flagged when a listed disclosure is dated after the newest TDnet id in CEBE’s `source` text (18 digits beginning with `1401`; digits 5–12 are `YYYYMMDD`). The source currently cites `140120261005546274`, which is 2026-10-05. If the source cites no TDnet id, the comparison uses CEBE’s as-of date.
- EDGAR requests send `User-Agent: BTC Treasury Tracker compound1980@proton.me` and wait at least 1 second between calls (the SEC fair-access limit is 10 requests/second). The CIK is checked against the submissions record (ticker and CIK). The company-ticker file is a cross-check when that file is reachable. If EDGAR is unreachable or a CIK does not verify, that company's cell says the SEC check is unavailable and the rest of the update still succeeds. The Metaplanet page is fetched with a browser User-Agent. If that fetch or parse fails, Metaplanet’s cell says the filing check is unavailable and the rest of the update still succeeds.
