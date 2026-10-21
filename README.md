# Bitcoin Treasury Tracker

Static site (`site/`) + data script (`scripts/update.mjs`) + GitHub Actions workflow that refreshes `site/data.json` every ~15 min and deploys to GitHub Pages. No API keys, no dependencies.

## Add a company
Append an entry to `config/companies.json` (see `_readme` there). If CEBE Tracker covers it, set `cebeTicker`; otherwise fill `manual` with btc_holdings, debt_usd, preferred_usd, cash_usd, basic_shares, as_of, source from the latest filing.
US SEC filers can set `sec_cik` (10-digit CIK). The update then records the latest 8-K, 8-K/A, 10-Q, 10-Q/A, 10-K, or 10-K/A from EDGAR, and the page links to that filing. Leave `sec_cik` unset for companies that do not file with the SEC — Metaplanet files in Japan, so it has no CIK. The script checks the CIK on EDGAR (the company-ticker list when that file is reachable, and the submissions record’s CIK and tickers) and skips the filing if they do not match. Optional `sec_ticker` overrides `ticker` when the EDGAR symbol differs from the display ticker.
CEBE feed tickers today: MSTR, MTPLF, ASST, TSWCF, ALCPB, OBTC3, SVIA, NAKA, DDC, HOGPF, XXI, CASH3.

## Run locally
    node scripts/update.mjs && npx serve site   # or: python3 -m http.server -d site
    node --test                                  # filing-date comparison, no network

## Deploy (GitHub Pages)
1. Create a public GitHub repo, push this folder to `main`.
2. Repo Settings → Pages → Source: **GitHub Actions**.
3. Actions tab → run "Update data & deploy" once. Site: https://<user>.github.io/<repo>/
Note: GitHub disables scheduled workflows in public repos after 60 days with no repo activity; push any commit (or re-enable in the Actions tab) to resume.

## Data sources
- Balance sheet (BTC held, debt, preferred, cash, basic shares) + CEBE construction: CEBE Tracker open feed https://cebetracker.io/api/v1/companies.json — free with attribution ("Data via CEBE Tracker, cebetracker.io"), which the page displays.
- Stock prices & FX: Yahoo Finance chart endpoint (unofficial, keyless).
- BTC price: CoinGecko simple price (falls back to Yahoo BTC-USD).
- SEC filing status (only companies with `sec_cik`): EDGAR submissions, `https://data.sec.gov/submissions/CIK##########.json`. This is a freshness check, not a data source for the figures. The page shows the latest filing (form, date, sec.gov link). It shows “Up to date” when that filing is not newer than the date CEBE’s figures are based on, and a note such as “New 8-K filed Oct 22 — data may not reflect it yet” when it is. CEBE numbers are never replaced with values parsed from the filing. The comparison uses the accession number when CEBE’s source cites that filing, otherwise the latest date written in the source, otherwise the as-of date.
- EDGAR requests send `User-Agent: btc-treasury-tracker github.com/Mozart2000/btc-treasury-tracker Mozart2000@users.noreply.github.com` and `Accept-Encoding: gzip, deflate`, and wait at least 1 second between calls (the SEC fair-access limit is 10 requests/second). The CIK is checked against the submissions record (ticker and CIK). The company-ticker file is a cross-check when it is reachable. If Node is blocked, the same request is retried once with curl. If EDGAR is unreachable or a CIK does not verify, that company’s SEC cell says the check is unavailable and the rest of the update still succeeds.
