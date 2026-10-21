// Fetches live data and writes site/data.json. Node 20+, no dependencies.
// Sources: CEBE Tracker open feed (balance sheets, CEBE), Yahoo Finance (stock + FX), CoinGecko (BTC).
// US filers with sec_cik also get an EDGAR filing-status check (figures stay from CEBE).
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'Mozilla/5.0 (btc-treasury-tracker)' };

// SEC fair access (https://www.sec.gov/os/webmaster-faq#developers): a declared
// User-Agent with an app name and contact, and well under 10 requests/second.
const SEC_UA = 'btc-treasury-tracker github.com/Mozart2000/btc-treasury-tracker (Mozart2000@users.noreply.github.com)';
const SEC_MIN_INTERVAL_MS = 500;
const SEC_FORMS = new Set(['8-K', '8-K/A', '10-Q', '10-Q/A', '10-K', '10-K/A']);
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let secNotBefore = 0;

async function getJSON(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

async function secFetchJSON(url) {
  const wait = secNotBefore - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': SEC_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const text = await r.text();
    if (!r.ok) {
      const title = text.match(/<title>([^<]+)<\/title>/i)?.[1]?.replace(/^SEC\.gov\s*\|\s*/i, '').trim();
      throw new Error(title ? `HTTP ${r.status} (${title})` : `HTTP ${r.status}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('response was not JSON');
    }
  } finally {
    secNotBefore = Date.now() + SEC_MIN_INTERVAL_MS;
  }
}

export function padCik(cik) {
  const digits = String(cik ?? '').trim().replace(/^CIK/i, '');
  if (!/^\d{1,10}$/.test(digits)) throw new Error(`invalid CIK ${cik}`);
  return digits.padStart(10, '0');
}

export function formatMonthDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  return `${MONTHS_SHORT[Number(m[2]) - 1]} ${Number(m[3])}`;
}

export function formatMonthDayYear(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  return `${MONTHS_SHORT[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

function isoDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function datesInText(text) {
  if (!text) return [];
  const found = [];
  const add = (year, month, day) => {
    const iso = isoDate(year, month, day);
    if (iso) found.push(iso);
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(+m[1], +m[2], +m[3]);
  const mon = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?';
  for (const m of text.matchAll(new RegExp(`\\b(${mon})\\.?\\s+(\\d{1,2}),\\s+(\\d{4})\\b`, 'gi'))) {
    add(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${mon})\\.?\\s+(\\d{4})\\b`, 'gi'))) {
    add(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  }
  return found;
}

export function sourceCitesAccession(source, accession) {
  if (!source || !accession) return false;
  const bare = String(accession).replace(/-/g, '');
  if (!/^\d{18}$/.test(bare)) return false;
  return new RegExp(`(?<!\\d)${bare}(?!\\d)`).test(source.replace(/-/g, ''));
}

// Current when CEBE cites this accession, or the filing date is not after the
// latest date in the CEBE source (fallback: the as-of date).
export function compareToCebe(filing, source, asOf) {
  const asOfDate = typeof asOf === 'string' ? (asOf.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] : null;
  const dates = datesInText(source).sort();
  const latestSourceDate = dates.length ? dates[dates.length - 1] : null;
  if (sourceCitesAccession(source, filing.accession)) {
    return { status: 'current', reference: 'accession', referenceDate: latestSourceDate || asOfDate };
  }
  const referenceDate = latestSourceDate || asOfDate;
  if (!referenceDate) return { status: 'unknown', reference: null, referenceDate: null };
  return {
    status: filing.filingDate > referenceDate ? 'newer' : 'current',
    reference: latestSourceDate ? 'source' : 'as_of',
    referenceDate,
  };
}

export function secNote(form, filingDate, status) {
  if (status === 'newer') return `New ${form} filed ${formatMonthDay(filingDate)} — data may not reflect it yet`;
  if (status === 'current') return 'Up to date';
  if (status === 'unknown') return 'Could not compare to CEBE date';
  return '';
}

export function filingUrl(cik, accession, primaryDocument) {
  const cikInt = String(Number(padCik(cik)));
  const dashed = String(accession || '');
  const acc = dashed.replace(/-/g, '');
  if (!/^\d{18}$/.test(acc)) return null;
  const base = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc}`;
  if (primaryDocument && !/[/\\]/.test(primaryDocument) && !primaryDocument.includes('..')) {
    return `${base}/${encodeURIComponent(primaryDocument)}`;
  }
  if (!/^\d{10}-\d{2}-\d{6}$/.test(dashed)) return null;
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${dashed}-index.html`;
}

export function latestFiling(submissions) {
  const rec = submissions?.filings?.recent;
  if (!rec?.form?.length) return null;
  let best = null;
  for (let i = 0; i < rec.form.length; i++) {
    const form = rec.form[i];
    if (!SEC_FORMS.has(form) || !/^\d{4}-\d{2}-\d{2}$/.test(rec.filingDate?.[i] || '')) continue;
    const row = {
      form,
      filingDate: rec.filingDate[i],
      acceptance: rec.acceptanceDateTime?.[i] || '',
      accession: rec.accessionNumber?.[i] || '',
      primaryDocument: rec.primaryDocument?.[i] || '',
    };
    if (!best || row.filingDate > best.filingDate || (row.filingDate === best.filingDate && row.acceptance > best.acceptance)) {
      best = row;
    }
  }
  return best;
}

async function loadTickerIndex() {
  const j = await secFetchJSON('https://www.sec.gov/files/company_tickers.json');
  const map = new Map();
  for (const v of Object.values(j || {})) {
    if (!v || v.ticker == null || v.cik_str == null) continue;
    map.set(String(v.ticker).toUpperCase(), { cik: padCik(v.cik_str), title: v.title || '' });
  }
  if (!map.size) throw new Error('ticker list was empty');
  return map;
}

async function secFilingStatus(co, row, tickerIndex) {
  const cik = padCik(co.sec_cik);
  const ticker = String(co.sec_ticker || co.ticker || '').trim().toUpperCase();
  if (!ticker) throw new Error('no ticker to verify against');
  const listed = tickerIndex?.get(ticker);
  if (listed && listed.cik !== cik) {
    throw new Error(`CIK ${cik} does not match EDGAR ticker ${ticker} (${listed.cik}${listed.title ? `, ${listed.title}` : ''})`);
  }
  const sub = await secFetchJSON(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (padCik(sub?.cik) !== cik) throw new Error(`submissions CIK does not match ${cik}`);
  const subTickers = (sub.tickers || []).map((t) => String(t).toUpperCase());
  const tickerVerified = subTickers.includes(ticker) || (listed && listed.cik === cik);
  if (!tickerVerified) {
    throw new Error(`could not verify CIK ${cik} (${sub.name || 'unknown'}) for ${ticker}`);
  }
  const filing = latestFiling(sub);
  if (!filing) throw new Error('no recent 8-K, 10-Q, or 10-K on EDGAR');
  const url = filingUrl(cik, filing.accession, filing.primaryDocument);
  if (!url) throw new Error('could not build a sec.gov filing link');
  const cmp = compareToCebe(filing, row.balance_sheet_source, row.balance_sheet_as_of);
  return {
    cik,
    entity_name: sub.name || null,
    form: filing.form,
    filing_date: filing.filingDate,
    accession: filing.accession,
    url,
    cebe_reference_date: cmp.referenceDate,
    cebe_reference: cmp.reference,
    status: cmp.status,
    note: secNote(filing.form, filing.filingDate, cmp.status),
  };
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

export async function main() {
  const cfg = JSON.parse(await readFile(path.join(root, 'config/companies.json'), 'utf8'));
  const errors = [];
  const btc = await btcPrice();

  let cebe = { companies: [] };
  try { cebe = await getJSON('https://cebetracker.io/api/v1/companies.json'); }
  catch (e) { errors.push(`CEBE feed: ${e.message}`); }
  const cebeBy = Object.fromEntries((cebe.companies || []).map((c) => [c.ticker, c]));

  let tickerIndex = null;
  if (cfg.companies.some((c) => c.sec_cik)) {
    try { tickerIndex = await loadTickerIndex(); }
    catch (e) { console.warn(`SEC company ticker list unavailable (${e.message}); verifying CIKs from submissions only`); }
  }

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

    // Filing status only. Never overwrite CEBE (or manual) balance-sheet figures.
    row.sec = null;
    if (co.sec_cik) {
      try {
        row.sec = await secFilingStatus(co, row, tickerIndex);
      } catch (e) {
        errors.push(`${co.name} SEC: ${e.message}`);
        row.sec = { status: 'unavailable' };
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
  for (const r of out) {
    const sec = r.sec?.form ? `${r.sec.form} ${r.sec.filing_date} ${r.sec.status} | ${r.sec.note} | ${r.sec.url}` : (r.sec?.status || 'n/a');
    console.log(`${r.ticker}: px ${r.stock?.price} ${r.stock?.currency} | shares ${r.basic_shares} | mNAV ${r.basic_mnav?.toFixed(3)} | EV ${r.ev_mnav?.toFixed(3)} | CEBE ${r.cebe_mnav?.toFixed(3)} (tracker ${r.cebe_tracker?.cebe_mnav_live}) | SEC ${sec}`);
  }
  if (errors.length) console.warn('Errors:', errors);
  if (!out.some((r) => r.basic_mnav)) process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
