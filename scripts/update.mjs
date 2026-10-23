// Fetches live data and writes site/data.json. Node 20+, no dependencies.
// Sources: CEBE Tracker open feed (balance sheets, CEBE), Yahoo Finance (stock + FX), CoinGecko (BTC).
// companies.json `filings` adds a freshness check only (figures stay from CEBE):
// SEC EDGAR for source "sec", Metaplanet's TDnet disclosure list for source "metaplanet".
// Basic-share history is data/share-history.json: one entry per company per distinct
// as_of. The CEBE feed only has the latest snapshot, and the Pages artifact does
// not survive the next run, so the workflow commits this file.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'User-Agent': 'Mozilla/5.0 (btc-treasury-tracker)' };
const PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// SEC fair access: "Name email" User-Agent, about 1 request/second (limit is 10).
const SEC_UA = 'BTC Treasury Tracker compound1980@proton.me';
const SEC_MIN_INTERVAL_MS = 1000;
const SEC_FORMS = new Set(['8-K', '8-K/A', '10-Q', '10-Q/A', '10-K', '10-K/A']);
const METAPLANET_DISCLOSURES_URL = 'https://metaplanet.jp/en/shareholders/disclosures';
const PDF_HOSTS = new Set(['contents.xj-storage.jp', 'metaplanet.jp', 'www.metaplanet.jp']);
const NEWER_LIST_CAP = 25;
// Order is the order topics are named in the cell.
const TOPIC_RULES = [
  ['bitcoin purchases', /(?:bitcoin|ビットコイン|\bbtc\b).{0,80}(?:purchase|acquisition|bought)|(?:purchase|acquisition|bought).{0,80}(?:bitcoin|ビットコイン|\bbtc\b)|ビットコイン.{0,40}購入|購入.{0,40}ビットコイン/i],
  ['convertible bonds', /convertible|転換社債|euro-yen|ユーロ円/i],
  ['share repurchases', /repurchase|buy-?back|自己株式/i],
  ['share issuance', /share issuance|issuance of (?:[\w-]+\s+){0,4}shares|public offering|third-party allotment|第三者割当|新株発行|株式の発行/i],
  ['preferred', /preferred stock|preferred shares|優先株|\bpreferred\b/i],
];
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

async function getText(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': PAGE_UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (!text) throw new Error('empty response');
  return text;
}

async function secFetchJSON(url) {
  const wait = secNotBefore - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  secNotBefore = Date.now() + SEC_MIN_INTERVAL_MS;
  const r = await fetch(url, {
    headers: { 'User-Agent': SEC_UA },
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

export function asOfDate(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(typeof value === 'string' ? value : '');
  return m ? m[1] : null;
}

function blankShareChange(asOf, basicShares) {
  return {
    as_of: asOf || null,
    basic_shares: Number.isInteger(basicShares) ? basicShares : null,
    previous_as_of: null,
    previous_basic_shares: null,
    delta: null,
    direction: 'none',
  };
}

// One row per company per as_of. A repeat of the same date and count is a no-op.
// A different count on a date already stored replaces that row.
export function applyShareSnapshot(history, { id, asOf, basicShares, source } = {}) {
  if (!history || typeof history !== 'object') throw new Error('share history missing');
  if (!history.companies || typeof history.companies !== 'object' || Array.isArray(history.companies)) {
    history.companies = {};
  }
  if (!id || typeof id !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf || '')) return false;
  if (!Number.isInteger(basicShares)) return false;
  const list = Array.isArray(history.companies[id]) ? history.companies[id] : (history.companies[id] = []);
  const note = typeof source === 'string' && source.trim() ? source.trim() : null;
  const existing = list.find((e) => e && e.as_of === asOf);
  if (existing) {
    if (existing.basic_shares === basicShares) return false;
    existing.basic_shares = basicShares;
    if (note) existing.source = note;
    existing.recorded_at = new Date().toISOString();
    return true;
  }
  const entry = { as_of: asOf, basic_shares: basicShares };
  if (note) entry.source = note;
  entry.recorded_at = new Date().toISOString();
  list.push(entry);
  list.sort((a, b) => (a.as_of < b.as_of ? -1 : a.as_of > b.as_of ? 1 : 0));
  return true;
}

// Change for the snapshot on screen: that as_of's basic count minus the prior
// distinct as_of. direction is none when there is no earlier count.
export function describeShareChange(entries, asOf, basicShares) {
  const list = [];
  for (const e of entries || []) {
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.as_of || '') || !Number.isInteger(e.basic_shares)) continue;
    if (!list.some((row) => row.as_of === e.as_of)) list.push({ as_of: e.as_of, basic_shares: e.basic_shares });
  }
  if (asOf && Number.isInteger(basicShares) && !list.some((row) => row.as_of === asOf)) {
    list.push({ as_of: asOf, basic_shares: basicShares });
  }
  list.sort((a, b) => (a.as_of < b.as_of ? -1 : a.as_of > b.as_of ? 1 : 0));
  const idx = list.findIndex((row) => row.as_of === asOf);
  if (idx < 1) return blankShareChange(asOf, basicShares);
  const prev = list[idx - 1];
  const cur = list[idx];
  const delta = cur.basic_shares - prev.basic_shares;
  return {
    as_of: cur.as_of,
    basic_shares: cur.basic_shares,
    previous_as_of: prev.as_of,
    previous_basic_shares: prev.basic_shares,
    delta,
    direction: delta === 0 ? 'unchanged' : delta > 0 ? 'up' : 'down',
  };
}

export async function loadShareHistory(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('share history was not an object');
    if (!data.companies || typeof data.companies !== 'object' || Array.isArray(data.companies)) data.companies = {};
    return data;
  } catch (e) {
    if (e && e.code === 'ENOENT') return { companies: {} };
    throw e;
  }
}

export async function saveShareHistory(file, history) {
  await writeFile(file, `${JSON.stringify(history, null, 2)}\n`);
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

// TDnet timely-disclosure ids are 18 digits beginning with 1401.
// Digits 5–12 (1-based) are the YYYYMMDD date CEBE is citing.
export function newestTdnetCitation(text) {
  let best = null;
  for (const m of String(text || '').matchAll(/\b(1401\d{14})\b/g)) {
    const id = m[1];
    const ymd = id.slice(4, 12);
    const date = isoDate(+ymd.slice(0, 4), +ymd.slice(4, 6), +ymd.slice(6, 8));
    if (!date) continue;
    if (!best || date > best.date || (date === best.date && id > best.id)) best = { id, date };
  }
  return best;
}

export function topicsOf(title) {
  const text = String(title || '');
  return TOPIC_RULES.filter(([, re]) => re.test(text)).map(([label]) => label);
}

export function topicsInDisclosures(list) {
  const found = new Set();
  for (const d of list || []) for (const topic of topicsOf(d.title)) found.add(topic);
  return TOPIC_RULES.map(([label]) => label).filter((label) => found.has(label));
}

export function formatTopicList(topics) {
  const list = [...(topics || [])];
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

export function metaplanetNote({ status, count, referenceDate, filingDate, topics }) {
  if (status === 'current') return 'Up to date';
  if (status === 'unknown') return 'Could not compare to CEBE date';
  if (status !== 'newer') return '';
  const topicBit = topics?.length ? `, including ${formatTopicList(topics)}` : '';
  if ((count || 0) <= 1) {
    return `New disclosure ${formatMonthDay(filingDate)}${topicBit} — data may not reflect it yet`;
  }
  return `${count} newer disclosures since ${formatMonthDay(referenceDate)}${topicBit} — data may not reflect them yet`;
}

export function safePdfUrl(url) {
  if (typeof url !== 'string' || url.includes('..') || url.includes('\\')) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!PDF_HOSTS.has(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Prefer the PDF link embedded in the page. Fall back to Metaplanet's public
// mirror when the id is a TDnet id and the embedded link is missing or off-host.
export function disclosurePdfUrl(filePath, id) {
  const direct = safePdfUrl(filePath);
  if (direct) return direct;
  const bare = String(id || '').replace(/\.pdf$/i, '');
  if (/^1401\d{14}$/.test(bare)) return `https://metaplanet.jp/disclosure-pdf/${bare}.pdf`;
  return null;
}

function extractJsonArray(text, start) {
  if (text[start] !== '[') throw new Error('disclosures payload was not an array');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < text.length; j++) {
    const ch = text[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, j + 1);
    }
  }
  throw new Error('disclosures payload was truncated');
}

// The disclosures page is server-rendered Next.js. The visible table is only
// the first page and has no PDF hrefs. The flight payload embeds the full
// list as { id, date, title, filePath, isEnglish }.
export function parseMetaplanetDisclosures(html) {
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  let text = '';
  let chunks = 0;
  for (const m of String(html || '').matchAll(re)) {
    text += JSON.parse(`"${m[1]}"`);
    chunks += 1;
  }
  if (!chunks) throw new Error('disclosures page had no data payload');
  const key = '"disclosures":[';
  const at = text.indexOf(key);
  if (at < 0) throw new Error('disclosures payload not found');
  const raw = JSON.parse(extractJsonArray(text, at + key.length - 1));
  if (!Array.isArray(raw)) throw new Error('disclosures payload was not an array');
  const out = [];
  for (const d of raw) {
    if (!d || typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
    const [year, month, day] = d.date.split('-').map(Number);
    if (isoDate(year, month, day) !== d.date) continue;
    const title = typeof d.title === 'string' ? d.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) continue;
    const id = String(d.id || '').replace(/\.pdf$/i, '');
    out.push({
      id,
      date: d.date,
      title,
      url: disclosurePdfUrl(d.filePath, id),
      english: d.isEnglish === true,
    });
  }
  if (!out.length) throw new Error('no disclosures with a date and title');
  return out;
}

// Headline is the first row on the newest date. Prefer an English title when
// the English page has one, matching the table at /en/disclosures.
export function newestDisclosure(list) {
  let bestDate = null;
  for (const d of list || []) {
    if (!bestDate || d.date > bestDate) bestDate = d.date;
  }
  if (!bestDate) return null;
  const onDay = list.filter((d) => d.date === bestDate);
  return onDay.find((d) => d.english) || onDay[0];
}

function disclosureRow(d) {
  return {
    date: d.date,
    title: d.title,
    url: d.url,
    id: d.id || null,
    material: topicsOf(d.title).length > 0,
  };
}

// English rows are what /en/shareholders/disclosures lists. Japanese copies of
// the same notice are not counted again. A later date that exists only in
// Japanese still flags, using those rows.
export function metaplanetFilingStatusFromDisclosures(disclosures, source, asOf) {
  if (!disclosures?.length) throw new Error('no disclosures');
  const tdnet = newestTdnetCitation(source);
  const asOfDate = typeof asOf === 'string' ? (asOf.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1] : null;
  const referenceDate = tdnet?.date || asOfDate || null;
  const reference = tdnet ? 'tdnet' : (asOfDate ? 'as_of' : null);
  const english = disclosures.filter((d) => d.english);
  const display = english.length ? english : disclosures;
  let newer = referenceDate ? display.filter((d) => d.date > referenceDate) : [];
  if (referenceDate && !newer.length) {
    newer = disclosures.filter((d) => d.date > referenceDate && !d.english);
  }
  const status = !referenceDate ? 'unknown' : (newer.length ? 'newer' : 'current');
  const shown = (status === 'newer' ? newestDisclosure(newer) : null) || newestDisclosure(display);
  if (!shown) throw new Error('no disclosure to show');
  const topics = topicsInDisclosures(newer);
  return {
    source: 'metaplanet',
    status,
    filing_date: shown.date,
    title: shown.title,
    url: shown.url,
    id: shown.id || null,
    material: topicsOf(shown.title).length > 0,
    topics,
    newer_count: newer.length,
    newer: newer.slice(0, NEWER_LIST_CAP).map(disclosureRow),
    cebe_reference_date: referenceDate,
    cebe_reference: reference,
    cebe_tdnet_id: tdnet?.id || null,
    note: metaplanetNote({
      status,
      count: newer.length,
      referenceDate,
      filingDate: shown.date,
      topics,
    }),
  };
}

export function filingSpec(co) {
  const f = co?.filings;
  if (f && typeof f === 'object') {
    const source = String(f.source || f.type || '').trim().toLowerCase();
    if (source === 'sec') return { source: 'sec', cik: f.cik ?? co.sec_cik, ticker: f.ticker || co.sec_ticker || '' };
    if (source === 'metaplanet' || source === 'tdnet') {
      return { source: 'metaplanet', url: f.url || METAPLANET_DISCLOSURES_URL };
    }
    throw new Error(`unknown filings source ${f.source || f.type || ''}`);
  }
  if (co?.sec_cik) return { source: 'sec', cik: co.sec_cik, ticker: co.sec_ticker || '' };
  return null;
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

let tickerIndexPromise;
function tickerIndexOnce() {
  if (!tickerIndexPromise) {
    tickerIndexPromise = loadTickerIndex().catch((e) => {
      console.warn(`SEC company ticker list unavailable (${e.message}); verifying CIKs from submissions only`);
      return null;
    });
  }
  return tickerIndexPromise;
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

async function secFilingStatus(co, row, spec) {
  const cik = padCik(spec?.cik || co.sec_cik);
  const ticker = String(spec?.ticker || co.sec_ticker || co.ticker || '').trim().toUpperCase();
  if (!ticker) throw new Error('no ticker to verify against');
  // Submissions first. The www.sec.gov ticker file is a cross-check and is
  // often rate-limited; it must not run before the filing lookup.
  const sub = await secFetchJSON(`https://data.sec.gov/submissions/CIK${cik}.json`);
  if (padCik(sub?.cik) !== cik) throw new Error(`submissions CIK does not match ${cik}`);
  const subTickers = (sub.tickers || []).map((t) => String(t).toUpperCase());
  if (!subTickers.includes(ticker)) {
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

// Latest completed regular-session close. While that session is open, the
// regular price is the live print, so the close is the previous session.
// Outside it, regularMarketPrice is that close (Yahoo leaves it there through
// the next pre-market). `previousClose` is often absent on this endpoint;
// `chartPreviousClose` on range=1d is the prior session.
export function regularSessionClose(meta, nowSec = Date.now() / 1000) {
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  const regular = meta.currentTradingPeriod?.regular;
  const prev = typeof meta.previousClose === 'number' ? meta.previousClose
    : typeof meta.chartPreviousClose === 'number' ? meta.chartPreviousClose
      : null;
  const open = regular && typeof regular.start === 'number' && typeof regular.end === 'number'
    && nowSec >= regular.start && nowSec < regular.end;
  if (open && prev != null) return prev;
  return meta.regularMarketPrice;
}

async function yahooQuote(symbol) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`);
  const m = j?.chart?.result?.[0]?.meta;
  if (!m || typeof m.regularMarketPrice !== 'number') throw new Error(`no Yahoo quote for ${symbol}`);
  return {
    price: m.regularMarketPrice,
    currency: m.currency,
    time: new Date(m.regularMarketTime * 1000).toISOString(),
    source: 'Yahoo Finance',
    close: regularSessionClose(m),
  };
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

const disclosurePages = new Map();
function loadMetaplanetDisclosures(url) {
  if (!disclosurePages.has(url)) {
    disclosurePages.set(url, (async () => parseMetaplanetDisclosures(await getText(url)))());
  }
  return disclosurePages.get(url);
}

function filingLog(row) {
  const f = row.filing;
  if (!f) return 'n/a';
  if (f.status === 'unavailable' || !f.filing_date) return f.status || 'unavailable';
  if (f.source === 'sec') return `${f.form} ${f.filing_date} ${f.status} | ${f.note} | ${f.url}`;
  const n = f.newer_count ? ` (${f.newer_count} newer)` : '';
  return `${f.filing_date} ${f.status}${n} | ${f.title} | ${f.note} | ${f.url}`;
}

export async function main() {
  const cfg = JSON.parse(await readFile(path.join(root, 'config/companies.json'), 'utf8'));
  const historyPath = path.join(root, 'data/share-history.json');
  const history = await loadShareHistory(historyPath);
  let historyDirty = false;
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
    let valuationQuote = null;
    try {
      const q = await yahooQuote(co.quote);
      valuationQuote = q;
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
        // Residual BTC NAV uses the same clamped senior-claims fraction as CEBE,
        // so stock price / residual NAV per share = CEBE mNAV.
        const residualNav = btcNav * (1 - claims);
        row.residual_nav_usd = residualNav;
        row.residual_nav_per_share_usd = residualNav / S;
        const nativePerUsd = row.stock.currency !== 'USD' && row.stock.price && row.stock.price_usd
          ? row.stock.price / row.stock.price_usd : null;
        if (nativePerUsd != null && isFinite(nativePerUsd)) {
          row.residual_nav_per_share_native = row.residual_nav_per_share_usd * nativePerUsd;
        }
        if (row.diluted_shares > 0) {
          row.residual_nav_per_share_diluted_usd = residualNav / row.diluted_shares;
          if (nativePerUsd != null && isFinite(nativePerUsd)) {
            row.residual_nav_per_share_diluted_native = row.residual_nav_per_share_diluted_usd * nativePerUsd;
          }
        }
        if (row.cebe_mnav != null && row.residual_nav_per_share_usd) {
          const implied = row.stock.price_usd / row.residual_nav_per_share_usd;
          if (Math.abs(implied - row.cebe_mnav) > 1e-8 * Math.abs(row.cebe_mnav)) {
            errors.push(`${co.name} residual NAV/share does not match CEBE mNAV`);
          }
        }
      }
    }

    // Display quote is the Stock price cell only. It is attached after mNAV
    // and residual NAV are computed from `quote`, and those fields are not read again.
    const displaySymbol = typeof co.display_quote === 'string' ? co.display_quote.trim() : '';
    if (displaySymbol) {
      if (row.stock && valuationQuote) {
        row.stock.symbol = co.quote;
        row.stock.close = valuationQuote.close ?? valuationQuote.price;
      }
      if (!row.stock) {
        errors.push(`${co.name} display quote: no price to fall back to for ${displaySymbol}`);
      } else {
        try {
          const dq = await yahooQuote(displaySymbol);
          const fx = await toUSD(dq.currency);
          row.stock.display = {
            symbol: displaySymbol,
            price: dq.price,
            currency: dq.currency,
            price_usd: dq.price * fx.rate,
            fx: fx.pair,
            time: dq.time,
            source: `Yahoo Finance (${displaySymbol})`,
          };
        } catch (e) {
          errors.push(`${co.name} display quote: ${e.message}; showing ${co.quote}`);
          row.stock.display_fallback = `${displaySymbol} unavailable; showing ${co.quote}`;
        }
      }
    }

    // Filing status only. Never overwrite CEBE (or manual) balance-sheet figures.
    row.sec = null;
    row.filing = null;
    let spec = null;
    try {
      spec = filingSpec(co);
    } catch (e) {
      errors.push(`${co.name} filings: ${e.message}`);
      row.filing = { status: 'unavailable' };
    }
    if (spec?.source === 'sec') {
      try {
        row.sec = await secFilingStatus(co, row, spec);
        row.filing = { source: 'sec', ...row.sec };
      } catch (e) {
        errors.push(`${co.name} SEC: ${e.message}`);
        row.sec = { status: 'unavailable' };
        row.filing = { source: 'sec', status: 'unavailable' };
      }
    } else if (spec?.source === 'metaplanet') {
      try {
        const disclosures = await loadMetaplanetDisclosures(spec.url);
        row.filing = metaplanetFilingStatusFromDisclosures(
          disclosures,
          row.balance_sheet_source,
          row.balance_sheet_as_of,
        );
      } catch (e) {
        errors.push(`${co.name} disclosures: ${e.message}`);
        row.filing = { source: 'metaplanet', status: 'unavailable' };
      }
    }
    const shareAsOf = asOfDate(row.balance_sheet_as_of);
    const shareCount = Number.isInteger(row.basic_shares) ? row.basic_shares : null;
    if (applyShareSnapshot(history, {
      id: co.id,
      asOf: shareAsOf,
      basicShares: shareCount,
      source: row.balance_sheet_source,
    })) historyDirty = true;
    row.share_change = describeShareChange(history.companies?.[co.id], shareAsOf, shareCount);
    out.push(row);
  }

  if (out.some((r) => r.sec?.cik)) {
    const tickerIndex = await tickerIndexOnce();
    if (tickerIndex) {
      for (const row of out) {
        if (!row.sec?.cik) continue;
        const co = cfg.companies.find((c) => c.id === row.id);
        const ticker = String(co?.filings?.ticker || co?.sec_ticker || co?.ticker || '').trim().toUpperCase();
        const listed = tickerIndex.get(ticker);
        if (listed && listed.cik !== row.sec.cik) {
          errors.push(`${row.name} SEC: CIK ${row.sec.cik} does not match EDGAR ticker ${ticker} (${listed.cik}${listed.title ? `, ${listed.title}` : ''})`);
          row.sec = { status: 'unavailable' };
          row.filing = { source: 'sec', status: 'unavailable' };
        }
      }
    }
  }

  if (historyDirty) {
    await saveShareHistory(historyPath, history);
    console.log('Updated data/share-history.json');
  } else {
    console.log('Share history unchanged');
  }

  const data = {
    generated_at: new Date().toISOString(),
    btc,
    cebe_feed: { as_of: cebe.as_of || null, rules_version: cebe.rules_version || null },
    companies: out,
    errors,
  };
  await writeFile(path.join(root, 'site/data.json'), JSON.stringify(data, null, 2) + '\n');
  console.log(`BTC $${btc.usd} (${btc.source})`);
  for (const r of out) {
    const residual = r.residual_nav_per_share_usd == null ? 'n/a'
      : `$${r.residual_nav_per_share_usd.toFixed(2)}${r.residual_nav_per_share_native != null ? ` (${r.residual_nav_per_share_native.toFixed(2)} ${r.stock?.currency})` : ''}${r.residual_nav_per_share_diluted_usd != null ? ` dil $${r.residual_nav_per_share_diluted_usd.toFixed(2)}` : ''} total $${(r.residual_nav_usd / 1e9).toFixed(2)}B`;
    const ch = r.share_change;
    const chText = !ch || ch.direction === 'none' ? 'no prior'
      : ch.direction === 'unchanged' ? `unchanged vs ${ch.previous_as_of}`
      : `${ch.delta > 0 ? '+' : ''}${ch.delta} vs ${ch.previous_as_of}`;
    const shown = r.stock?.display
      ? ` | display ${r.stock.display.symbol} ${r.stock.display.price} ${r.stock.display.currency} | close ${r.stock.symbol} ${r.stock.close}`
      : r.stock?.display_fallback ? ` | ${r.stock.display_fallback}` : '';
    console.log(`${r.ticker}: px ${r.stock?.price} ${r.stock?.currency}${shown} | residual/sh ${residual} | shares ${r.basic_shares} | Δ ${chText} | mNAV ${r.basic_mnav?.toFixed(3)} | EV ${r.ev_mnav?.toFixed(3)} | CEBE ${r.cebe_mnav?.toFixed(3)} (tracker ${r.cebe_tracker?.cebe_mnav_live}) | filing ${filingLog(r)}`);
  }
  if (errors.length) console.warn('Errors:', errors);
  if (!out.some((r) => r.basic_mnav)) process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) main().catch((e) => { console.error(e); process.exit(1); });
