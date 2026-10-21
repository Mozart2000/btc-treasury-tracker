# Bitcoin Treasury Tracker

Static site (`site/`) + data script (`scripts/update.mjs`) + GitHub Actions workflow that refreshes `site/data.json` every ~15 min and deploys to GitHub Pages. No API keys, no dependencies.

## Add a company
Append an entry to `config/companies.json` (see `_readme` there). If CEBE Tracker covers it, set `cebeTicker`; otherwise fill `manual` with btc_holdings, debt_usd, preferred_usd, cash_usd, basic_shares, as_of, source from the latest filing.
CEBE feed tickers today: MSTR, MTPLF, ASST, TSWCF, ALCPB, OBTC3, SVIA, NAKA, DDC, HOGPF, XXI, CASH3.

## Run locally
    node scripts/update.mjs && npx serve site   # or: python3 -m http.server -d site

## Deploy (GitHub Pages)
1. Create a public GitHub repo, push this folder to `main`.
2. Repo Settings → Pages → Source: **GitHub Actions**.
3. Actions tab → run "Update data & deploy" once. Site: https://<user>.github.io/<repo>/
Note: GitHub disables scheduled workflows in public repos after 60 days with no repo activity; push any commit (or re-enable in the Actions tab) to resume.

## Data sources
- Balance sheet (BTC held, debt, preferred, cash, basic shares) + CEBE construction: CEBE Tracker open feed https://cebetracker.io/api/v1/companies.json — free with attribution ("Data via CEBE Tracker, cebetracker.io"), which the page displays.
- Stock prices & FX: Yahoo Finance chart endpoint (unofficial, keyless).
- BTC price: CoinGecko simple price (falls back to Yahoo BTC-USD).
