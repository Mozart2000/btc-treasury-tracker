// Fetches live data and writes site/data.json. Node 20+, no dependencies.
// Sources: CEBE Tracker open feed (balance sheets, CEBE), Yahoo Finance (stock + FX), CoinGecko (BTC).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'Mozilla/5.0 (btc-treasury-tracker)' };

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function yahooQuote(symbol) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`);
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || typeof m.regularMarketPrice !== 'number') throw new Error(`no Yahoo quote for ${symbol}`);
  return { price: m.regularMarketPrice, currency: m.currency, time: new Date(m.regularMarketTime * 1000).toISOString(), source: 'Yahoo Finance' };
}

async function btcPrice() {
  try {
    const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true');
    return { usd: j.bitcoin.usd, time: new Date(j.bitcoin.last_updated_at * 1000).toISOString(), source: 'CoinGecko' };
  } catch (e) {
    const q = await yahooQuote('BTC-USD');
    return { usd: q.price, time: q.time, source: 'Yahoo Finance (BTC-USD)' };
  }
}

const fxCache = {};
async function toUSD(currency) {
  if (currency === 'USD') return { rate: 1, pair: null };
  if (!fxCache[currency]) {
    const q = await yahooQuote(`${currency}=X`); // USD/JPY etc. (units of currency per 1 USD)
    fxCache[currency] = { rate: 1 / q.price, pair: `USD/${currency} ${q.price}`, time: q.time };
  }
  return fxCache[currency];
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

async function main() {
  const cfg = JSON.parse(await readFile(path.join(root, 'config/companies.json'), 'utf8'));
  const errors = [];
  const btc = await btcPrice();

  let cebe = { companies: [] };
  try { cebe = await getJSON('https://cebetracker.io/api/v1/companies.json'); }
  catch (e) { errors.push(`CEBE feed: ${e.message}`); }
  const cebeBy = Object.fromEntries((cebe.companies || []).map((c) => [c.ticker, c]));

  const out = [];
  for (const co of cfg.companies) {
    const f = cebeBy[co.cebeTicker] || {};
    const m = co.manual || {};
    const pick = (k) => (m[k] !== undefined ? m[k] : f[k]);
    const row = {
      id: co.id, name: co.name, ticker: co.ticker, exchange: co.exchange, website: co.website,
      btc_holdings: num(pick('btc_holdings')),
      debt_usd: num(pick('debt_usd')),
      preferred_usd: num(pick('preferred_usd')),
      cash_usd: num(pick('cash_usd')),
      strc_holdings_usd: num(pick('strc_holdings_usd')) ?? 0,
      net_claims_usd: m.net_claims_usd !== undefined ? num(m.net_claims_usd) : num(f.net_claims_usd),
      btc_claim_static: num(pick('btc_claim_static')) ?? 0,
      basic_shares: num(pick('basic_shares')),
      diluted_shares: num(m.diluted_shares),
      diluted_shares_source: m.diluted_shares_source || null,
      balance_sheet_as_of: m.as_of || f.as_of || null,
      balance_sheet_source: m.source || f.source || null,
      cebe_tracker: f.ticker ? { cebe_mnav_live: num(f.cebe_mnav_live), cebe_sats_live: num(f.cebe_sats_live), senior_claims_pct_live: num(f.senior_claims_pct_live), stock_price_usd: num(f.stock_price), stock_venue: f.stock_price_venue, url: `https://cebetracker.io/company/${f.ticker}/` } : null,
    };
    try {
      const q = await yahooQuote(co.quote);
      const fx = await toUSD(q.currency);
      row.stock = { price: q.price, currency: q.currency, price_usd: q.price * fx.rate, fx: fx.pair, time: q.time, source: `Yahoo Finance (${co.quote})` };
    } catch (e) {
      errors.push(`${co.name} quote: ${e.message}`);
      if (f.stock_price) row.stock = { price: f.stock_price_native, currency: f.stock_price_currency, price_usd: f.stock_price, time: f.stock_price_as_of, source: `CEBE Tracker (${f.stock_price_venue})` };
    }

    // Metrics at the live BTC price
    const P = btc.usd, B = row.btc_holdings, S = row.basic_shares;
    if (row.stock && B && S) {
      const mcap = row.stock.price_usd * S;
      const btcNav = B * P;
      row.market_cap_usd = mcap;
      row.btc_nav_usd = btcNav;
      row.basic_mnav = mcap / btcNav;
      if (row.debt_usd !== null && row.preferred_usd !== null && row.cash_usd !== null) {
        row.ev_usd = mcap + row.debt_usd + row.preferred_usd - row.cash_usd;
        row.ev_mnav = row.ev_usd / btcNav;
      }
      // CEBE construction (https://cebetracker.io/api/docs#the-formula)
      const fiatClaims = row.net_claims_usd !== null ? row.net_claims_usd
        : (row.debt_usd ?? NaN) + (row.preferred_usd ?? NaN) - (row.cash_usd ?? NaN) - row.strc_holdings_usd;
      if (isFinite(fiatClaims)) {
        const claims = Math.min(1, Math.max(0, (fiatClaims / P + row.btc_claim_static) / B));
        row.senior_claims_pct = claims * 100;
        row.cebe_sats = Math.round(B * (1 - claims) / S * 1e8);
        row.cebe_mnav = claims < 1 ? mcap / (B * (1 - claims) * P) : null;
      }
    }
    out.push(row);
  }

  const data = {
    generated_at: new Date().toISOString(),
    btc,
    cebe_feed: { as_of: cebe.as_of || null, rules_version: cebe.rules_version || null },
    companies: out,
    errors,
  };
  await writeFile(path.join(root, 'site/data.json'), JSON.stringify(data, null, 2));
  console.log(`BTC $${btc.usd} (${btc.source})`);
  for (const r of out) console.log(`${r.ticker}: px ${r.stock?.price} ${r.stock?.currency} | shares ${r.basic_shares} | mNAV ${r.basic_mnav?.toFixed(3)} | EV ${r.ev_mnav?.toFixed(3)} | CEBE ${r.cebe_mnav?.toFixed(3)} (tracker ${r.cebe_tracker?.cebe_mnav_live})`);
  if (errors.length) console.warn('Errors:', errors);
  if (!out.some((r) => r.basic_mnav)) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
