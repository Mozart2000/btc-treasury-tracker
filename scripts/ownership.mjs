// Institutional ownership for the Holdings table.
// US issuers: Nasdaq's Form 13F institutional-holdings total, divided by the
// basic shares outstanding already shown on the page (not Nasdaq's percent,
// which uses a stale share count). Holders above 5% also consider the latest
// Schedule 13D/13G on EDGAR, which is the official beneficial-ownership filing.
// Metaplanet: Japan has no 13F. The percent is not reported. Holders above 5%
// come from Metaplanet's major-shareholder notices and its semiannual register.
// The result is cached in data/institutional-ownership.json and refreshed at
// most about once a day. A failed fetch keeps the previous figures.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const OWNERSHIP_REFRESH_MS = 20 * 60 * 60 * 1000;
const PAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEC_UA = 'BTC Treasury Tracker compound1980@proton.me';
const SEC_MIN_INTERVAL_MS = 1000;
const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_PATTERN = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

const JP_REASON = 'Japan has no Form 13F. Metaplanet does not publish a total of shares held by institutions, so this percentage is not reported.';

// Same organization, reported under more than one legal entity. Listed
// separately. Never added together.
const FAMILIES = [
  { label: 'Vanguard', pattern: /^vanguard\b/ },
  { label: 'BlackRock', pattern: /^blackrock\b/ },
  { label: 'Capital Group', pattern: /^capital (international|world|research)\b/ },
  { label: 'State Street', pattern: /^state street\b/ },
  { label: 'FMR', pattern: /^(fmr|fidelity)\b/ },
];

let secNotBefore = 0;

function isoDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeWidth(text) {
  return String(text || '').replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

export function parseEnglishDate(text) {
  const m = new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i').exec(text || '');
  if (!m) return null;
  return isoDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
}

export function parseJapaneseDate(text) {
  const t = normalizeWidth(text);
  const m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(t);
  if (!m) return null;
  return isoDate(+m[1], +m[2], +m[3]);
}

function parseMdY(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(text || '').trim());
  if (!m) return null;
  return isoDate(+m[3], +m[1], +m[2]);
}

function parseCount(text) {
  const digits = String(text || '').replace(/,/g, '').trim();
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

export function normalizeHolderName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(incorporated|corporation|company|limited|inc|llc|corp|ltd|plc|lp|co|sa|nv|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ownershipSubtext(asOf, prefix, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf || '');
  if (!m) return '';
  const md = `${MONTHS_SHORT[Number(m[2]) - 1]} ${Number(m[3])}`;
  const year = Number(m[1]) === now.getUTCFullYear() ? '' : `, ${m[1]}`;
  const head = prefix ? `${prefix} ` : '';
  return `${head}${md}${year}`;
}

export function shouldRefreshOwnership(entry, now = Date.now(), maxAgeMs = OWNERSHIP_REFRESH_MS) {
  const stamp = entry?.attempted_at || entry?.fetched_at;
  if (!stamp) return true;
  const then = Date.parse(stamp);
  if (!Number.isFinite(then)) return true;
  const at = now instanceof Date ? now.getTime() : now;
  return at - then >= maxAgeMs;
}

// A 13D/13G share count is in today's units only when the shares outstanding
// implied by that filing are still the same order of magnitude as the current
// basic count. A pre-split or pre-merger filing fails this and is dropped.
export function filingMatchesShareBase(shares, percent, basicShares) {
  if (!Number.isFinite(percent) || percent <= 0 || !(basicShares > 0) || !(shares > 0)) return false;
  const implied = shares / (percent / 100);
  const ratio = implied / basicShares;
  return ratio >= 0.1 && ratio <= 5;
}

export function parseNasdaqHoldings(payload) {
  const data = payload?.data;
  const rows = data?.activePositions?.rows;
  const total = (rows || []).find((row) => /total institutional shares/i.test(row?.positions || ''));
  const institutionalShares = parseCount(total?.shares);
  const holdersCount = parseCount(total?.holders) ?? parseCount(data?.holdingsTransactions?.totalRecords);
  const positions = [];
  for (const row of data?.holdingsTransactions?.table?.rows || []) {
    const shares = parseCount(row?.sharesHeld);
    const name = String(row?.ownerName || '').replace(/\s+/g, ' ').trim();
    if (!name || shares == null) continue;
    const asOf = parseMdY(row?.date);
    let url = typeof row?.url === 'string' ? row.url : '';
    if (url.startsWith('/')) url = `https://www.nasdaq.com${url}`;
    if (!/^https:\/\/www\.nasdaq\.com\//.test(url)) url = null;
    positions.push({
      name,
      shares,
      as_of: asOf,
      source: 'Form 13F',
      url,
      group: 'owners',
    });
  }
  const dates = positions.map((p) => p.as_of).filter(Boolean).sort();
  return {
    institutional_shares: institutionalShares,
    holders_count: holdersCount,
    as_of: dates.length ? dates[dates.length - 1] : null,
    positions,
  };
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlTagAll(xml, tag) {
  return [...String(xml || '').matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'gi'))]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parse13DGXml(xml) {
  const shares = xmlTagAll(xml, 'aggregateAmountOwned').map(parseCount).filter((n) => n != null);
  const percents = xmlTagAll(xml, 'percentOfClass').map((s) => Number(String(s).replace(/%/g, ''))).filter((n) => Number.isFinite(n));
  const names = xmlTagAll(xml, 'reportingPersonName');
  const event = xmlTagAll(xml, 'dateOfEvent')[0] || xmlTagAll(xml, 'eventDate')[0] || '';
  const exit = /<item5\b[\s\S]*?<(?:is5PercentOrLess|classOwnership5PercentOrLess|fivePercentOrLess)>\s*Y\s*</i.test(xml);
  return { shares, percents, names, asOf: parseMdY(event) || parseEnglishDate(event), exit, xml: true };
}

function parse13DGHtml(text) {
  const shares = [];
  const percents = [];
  const names = [];
  const shareRe = /AGGREGATE AMOUNT BENEFICIALLY OWNED BY EACH REPORTING PERSON\s*([\d,]+)/gi;
  const pctRe = /PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW\s*(?:\(\s*\d+\s*\)|\d+)?\s*([\d.]+)\s*%/gi;
  for (const m of text.matchAll(shareRe)) {
    const n = parseCount(m[1]);
    if (n != null) shares.push(n);
  }
  for (const m of text.matchAll(pctRe)) percents.push(Number(m[1]));
  const namePatterns = [
    /\(ENTITIES ONLY\)\.?\s+(.+?)\s+\(?\d+\)?\.?\s*CHECK THE APPROPRIATE/gi,
    /NAMES OF REPORTING PERSONS\.?\s+(.+?)\s+\(?\d+\)?\.?\s*CHECK THE APPROPRIATE/gi,
  ];
  for (const nameRe of namePatterns) {
    for (const m of text.matchAll(nameRe)) {
      const name = m[1].replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
      if (name && !/identification|reporting person/i.test(name)) names.push(name);
    }
    if (names.length) break;
  }
  const item5 = (text.match(/Item 5\b(.{0,700}?)Item 6\b/i) || [])[1] || '';
  const exit = /ceased to be the beneficial owner of more than (?:five|5) percent/i.test(item5)
    && !/not applicable/i.test(item5)
    && /(?:☒|☑|\[X\]|\[x\])/ .test(item5)
    && !/\bonly\b/i.test(item5);
  return { shares, percents, names, asOf: statementEventDate(text), exit, xml: false };
}

// Cover pages put the event date on either side of the label. HTML filings
// from EDGAR usually print "September 30, 2024 (Date of Event ...)".
function statementEventDate(text) {
  const after = text.match(new RegExp(`Date of Event(?: Which Requires Filing of this Statement)?\\s+((?:${MONTH_PATTERN})\\.?\\s+\\d{1,2},?\\s+\\d{4})`, 'i'));
  if (after) return parseEnglishDate(after[1]);
  const before = text.match(new RegExp(`((?:${MONTH_PATTERN})\\.?\\s+\\d{1,2},?\\s+\\d{4})[^A-Za-z]{0,80}\\(\\s*Date of Event`, 'i'));
  if (before) return parseEnglishDate(before[1]);
  return null;
}

// The filing index lists the complete submission, exhibits, and the 13D/13G
// itself. Prefer the schedule (xml, then html, then txt). Skip index pages
// and exhibits such as d886741dex991.htm, which sort ahead of the schedule.
export function pickFilingDocument(names, adsh) {
  const complete = new Set();
  if (adsh) {
    complete.add(`${adsh}.txt`);
    complete.add(`${String(adsh).replace(/-/g, '')}.txt`);
  }
  const kind = (n) => (/\.xml$/i.test(n) ? 3 : /\.html?$/i.test(n) ? 2 : /\.txt$/i.test(n) ? 1 : 0);
  const isExhibit = (n) => /(?:^|[^a-z])(?:ex|dex)-?\d/i.test(n) || /exhibit/i.test(n);
  const ranked = (names || [])
    .filter((n) => typeof n === 'string' && n && !/[/\\]/.test(n) && kind(n) > 0 && !/index/i.test(n))
    .map((n) => {
      let score = kind(n) * 10;
      if (/13[dg]/i.test(n)) score += 5;
      if (isExhibit(n)) score -= 30;
      if (complete.has(n)) score -= 15;
      return { n, score };
    })
    .sort((a, b) => b.score - a.score || a.n.localeCompare(b.n));
  return ranked[0]?.n || null;
}

function sameHolder(a, b) {
  const x = normalizeHolderName(a);
  const y = normalizeHolderName(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// One holder per filing: the reporting person with the most shares. A joint
// filing repeats that share count for every reporting person; those names are
// not added together, and the EDGAR filer is the one kept when it is among them.
// Item 5 exit filings are not a current position. A share count from a
// different capital structure (split, reverse merger) is dropped.
export function parse13DGDocument(raw, { basicShares, filingDate, form, url, filerName } = {}) {
  const text = String(raw || '');
  const parsed = /<aggregateAmountOwned>/i.test(text) || /<edgarSubmission[\s>]/i.test(text)
    ? parse13DGXml(text)
    : parse13DGHtml(htmlToText(text));
  if (parsed.exit) return null;
  const rows = [];
  const n = Math.max(parsed.shares.length, parsed.percents.length, parsed.names.length);
  for (let i = 0; i < n; i++) {
    const shares = parsed.shares[i] ?? (parsed.shares.length === 1 ? parsed.shares[0] : null);
    const percent = parsed.percents[i] ?? (parsed.percents.length === 1 ? parsed.percents[0] : null);
    if (!(shares > 0) || !Number.isFinite(percent)) continue;
    if (!filingMatchesShareBase(shares, percent, basicShares)) continue;
    const name = (parsed.names[i] || (parsed.names.length === 1 ? parsed.names[0] : '') || '').replace(/\s+/g, ' ').trim();
    rows.push({ shares, percent, name: name || null });
  }
  if (!rows.length) return null;
  const maxShares = Math.max(...rows.map((r) => r.shares));
  const top = rows.filter((r) => r.shares === maxShares);
  const filer = String(filerName || '').replace(/\s+/g, ' ').trim();
  const matched = top.find((r) => r.name && sameHolder(r.name, filer));
  const best = matched || top.find((r) => r.name) || top[0];
  const name = (best.name || filer).replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const seen = new Set([normalizeHolderName(name)]);
  const joint = [];
  for (const r of top) {
    const key = normalizeHolderName(r.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    joint.push(r.name);
  }
  return {
    name,
    shares: best.shares,
    percent_reported: best.percent,
    as_of: parsed.asOf || filingDate || null,
    filing_date: filingDate || null,
    source: form || 'Schedule 13D/13G',
    url: url || null,
    group: 'owners',
    joint_names: joint,
  };
}

function collapse(text) {
  return String(text || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ');
}

// English TDnet notices. The 2026 template says "Corporate Name" and "After
// the Change". The 2025 template says "① Name" and "After Change". The share
// count is the last "N shares" in the after-change block (the total column).
export function parseMajorShareholderNotice(text) {
  const src = collapse(text);
  const body = src.split(/Former Largest/i)[0];
  let name = (body.match(/Corporate Name\s+([A-Z][A-Za-z0-9&.,'() -]+?)(?:\s+Location|\s+Title and Name|\n)/) || [])[1];
  if (!name) name = (body.match(/①\s*Name\s+([A-Za-z][^\n]+)/) || [])[1];
  if (!name) name = (body.match(/\bName\s{2,}([A-Z][A-Za-z0-9&.,'() -]+)/) || [])[1];
  name = name ? name.replace(/\s+/g, ' ').trim() : '';
  if (!name || /metaplanet/i.test(name)) return null;
  // The heading "Before and After the Change" and the note "after the change,
  // calculated" are not the table row. The row itself is "After the" / "After Change".
  const withoutHeading = src.replace(/Before and After the Change/gi, ' ');
  const notesAt = withoutHeading.search(/\n\s*(?:Notes?\s*:|\(Notes?\))/i);
  const beforeNotes = notesAt >= 0 ? withoutHeading.slice(0, notesAt) : withoutHeading;
  const afterAt = beforeNotes.search(/\bAfter the\b|\bAfter Change\b/i);
  if (afterAt < 0) return null;
  const after = beforeNotes.slice(afterAt).replace(/\s+/g, ' ');
  const shareMatches = [...after.matchAll(/(\d{1,3}(?:,\d{3})+)\s+shares\b/gi)];
  if (!shareMatches.length) {
    const labeled = [...after.matchAll(/Shares:\s*(\d{1,3}(?:,\d{3})+)/gi)];
    if (labeled.length) shareMatches.push(labeled[labeled.length - 1]);
  }
  if (!shareMatches.length) return null;
  const shares = parseCount(shareMatches[shareMatches.length - 1][1]);
  if (shares == null) return null;
  const dated = src.match(new RegExp(`Date of Change\\s+((?:${MONTH_PATTERN})\\.?\\s+\\d{1,2},?\\s+\\d{4})`, 'i'));
  const asOf = (dated && parseEnglishDate(dated[1])) || parseEnglishDate(after) || parseEnglishDate(src);
  const report = src.match(/Large\s+Shareholding\s+Report\s*\(([^)]+)\)\s+filed on\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/i)
    || src.match(/Amendment Report No\.\s*(\d+)[^.]{0,80}?filed on\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4})/i);
  const preferred = src.match(/([\d,]+)\s+non-voting\s+Class\s+B\s+Preferred/i)
    || src.match(/includes\s+([\d,]+)\s+Class\s+B(?:\s+preferred)?/i);
  const ceased = /ceased to|no longer qualify|fallen below|fell below/i.test(src);
  return {
    name,
    shares,
    as_of: asOf,
    ceased,
    report: report ? report[1].replace(/\s+/g, ' ').trim() : null,
    report_filed: report ? parseEnglishDate(report[2]) : null,
    preferred_excluded: preferred ? parseCount(preferred[1]) : null,
    group: 'owners',
    source: 'Major shareholder notice',
  };
}

function tsvWords(tsv) {
  const words = [];
  for (const line of String(tsv || '').split('\n').slice(1)) {
    const p = line.split('\t');
    if (p.length < 12 || p[11].startsWith('###')) continue;
    const conf = Number(p[10]);
    const left = Number(p[6]);
    const top = Number(p[7]);
    const page = Number(p[1]);
    if (!Number.isFinite(conf) || conf < 0 || !Number.isFinite(left) || !Number.isFinite(top)) continue;
    words.push({ page, top, left, text: p[11] });
  }
  return words;
}

function clusterLines(items) {
  const rows = [];
  for (const w of [...items].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.top - w.top) < 4) last.words.push(w);
    else rows.push({ top: w.top, words: [w] });
  }
  return rows;
}

function cleanRegisterName(raw) {
  let s = String(raw || '').split('（')[0].split('(')[0];
  s = s.replace(/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]+/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[^A-Za-z]+/, '').trim();
  return s;
}

// Top of the shareholder register in a 半期報告書 / 有価証券報告書.
// Names are the Latin text in the left column. Custodian accounts stay
// labeled as register names; they are not treated as one beneficial owner.
export function parseRegisterHolders(tsv) {
  const words = tsvWords(tsv);
  const section = words.find((w) => w.text.includes('所有株式数別'));
  if (!section) return { as_of: null, holders: [] };
  const pages = new Set([section.page, section.page + 1]);
  const pageWords = words.filter((w) => pages.has(w.page));
  let asOf = null;
  for (const w of pageWords) {
    if (w.page === section.page && w.top <= section.top + 30) {
      asOf = parseJapaneseDate(w.text) || asOf;
    }
  }
  const holders = [];
  for (const page of [section.page, section.page + 1]) {
    const pw = pageWords.filter((w) => w.page === page);
    const nameRows = clusterLines(pw.filter((w) => w.left < 190));
    const stop = nameRows.find((row) => row.words.map((w) => w.text).join('').replace(/\s/g, '').startsWith('計'));
    const shareRows = [];
    for (const row of clusterLines(pw)) {
      let shares = null;
      let pct = null;
      for (const w of row.words) {
        if (w.left > 360 && /^\d{1,3}(?:,\d{3})+$/.test(w.text)) shares = w.text;
        if (w.left > 430 && /^\d+\.\d{2}$/.test(w.text)) pct = w.text;
      }
      if (shares && pct) shareRows.push({ top: row.top, shares, pct });
    }
    for (const row of shareRows) {
      if (stop && row.top >= stop.top - 2) break;
      const bits = nameRows
        .filter((nr) => row.top - 36 <= nr.top && nr.top <= row.top + 8)
        .map((nr) => nr.words.slice().sort((a, b) => a.left - b.left).map((w) => w.text).join(' '));
      const name = cleanRegisterName(bits.join(' '));
      const shares = parseCount(row.shares);
      if (!name || shares == null || name === '計') continue;
      holders.push({
        name,
        shares,
        register_pct: Number(row.pct),
        as_of: asOf,
        source: 'Shareholder register',
        group: 'register',
        url: null,
      });
    }
    if (stop) break;
  }
  return { as_of: asOf, holders };
}

// Footnotes that quote a large-shareholding report the company could not
// confirm on the register. These are notes, not counted share holdings.
// 株券等 can include rights, not only shares outstanding.
export function parseUnconfirmedNotes(text) {
  const flat = normalizeWidth(text).replace(/\s+/g, '');
  const notes = [];
  const evo = /エボ.?ファンド（EvoFund）及びその共同保有者が(\d{4})年(\d{1,2})月(\d{1,2})日現在[\s\S]{0,500}?(\d{1,3}(?:,\d{3})+)/.exec(flat);
  if (evo) {
    const asOf = isoDate(+evo[1], +evo[2], +evo[3]);
    const shares = parseCount(evo[4]);
    if (asOf && shares != null) {
      notes.push(`Evo Fund and its joint holders reported ${shares.toLocaleString('en-US')} share-equivalents (株券等, which can include rights as well as shares) as of ${asOf} in a large-shareholding change report. Metaplanet said it could not confirm the shares actually held, so that figure is not listed as a share holding.`);
    }
  }
  return notes;
}

export function familyNotes(positions, displayed, basicShares) {
  const shown = new Set((displayed || []).map((h) => normalizeHolderName(h.name)));
  const notes = [];
  for (const family of FAMILIES) {
    const members = [];
    const seen = new Set();
    for (const h of positions || []) {
      if (!family.pattern.test(normalizeHolderName(h.name))) continue;
      const key = normalizeHolderName(h.name);
      if (seen.has(key)) continue;
      seen.add(key);
      members.push(h);
    }
    if (members.length < 2) continue;
    if (!members.some((h) => shown.has(normalizeHolderName(h.name)))) continue;
    const bits = members.map((h) => {
      const pct = basicShares > 0 ? ` (${(h.shares / basicShares * 100).toFixed(1)}%)` : '';
      const when = h.as_of ? ` as of ${h.as_of}` : '';
      return `${h.name} ${h.shares.toLocaleString('en-US')}${pct}${when}`;
    });
    notes.push(`${family.label} reports under several entities. They were not combined: ${bits.join('; ')}.`);
  }
  return notes;
}

function holderPct(shares, basicShares) {
  if (!(basicShares > 0) || !(shares > 0)) return null;
  return shares / basicShares * 100;
}

function viewHolder(h, basicShares, now) {
  const pct = holderPct(h.shares, basicShares);
  return {
    name: h.name,
    shares: h.shares,
    pct,
    above: pct != null && pct > 5,
    as_of: h.as_of || null,
    as_of_label: h.as_of ? ownershipSubtext(h.as_of, '', now) : '',
    source: h.source || '',
    url: h.url || null,
    group: h.group || 'owners',
    filing_date: h.filing_date || null,
    preferred_excluded: h.preferred_excluded || null,
    report: h.report || null,
  };
}

// Merge a 13F position with a 13D/13G for the same name. The later as-of wins.
// Related entities that do not normalize to the same name stay separate.
function mergeOwners(positions, beneficial) {
  const byKey = new Map();
  const put = (h) => {
    const key = normalizeHolderName(h.name);
    if (!key) return;
    const prev = byKey.get(key);
    if (!prev || (h.as_of || '') > (prev.as_of || '')) byKey.set(key, h);
  };
  for (const h of positions || []) put(h);
  for (const h of beneficial || []) put(h);
  return [...byKey.values()];
}

function floorDetail(floor) {
  const shares = Number.isInteger(floor.shares) ? floor.shares.toLocaleString('en-US') : null;
  const rights = Number.isInteger(floor.voting_rights) ? floor.voting_rights.toLocaleString('en-US') : null;
  const total = Number.isInteger(floor.voting_rights_total) ? floor.voting_rights_total.toLocaleString('en-US') : null;
  const ratio = rights && total ? `${rights} voting rights ÷ ${total} total voting rights` : null;
  const holder = floor.holder || 'The reporting holder';
  const when = floor.as_of || 'the report date';
  const report = floor.report ? `, ${floor.report}` : '';
  const bits = [
    `${Number(floor.pct).toFixed(1)}% is a floor: only holders that have filed a Japan large-shareholding report above 5%. It is not a total of every institution.`,
    shares ? `${holder} reports ${shares} shares${ratio ? ` (${ratio})` : ''} as of ${when}${report}.` : null,
  ];
  return bits.filter(Boolean).join(' ');
}

function supplementalOwnershipNotes(entry) {
  const notes = [];
  const est = entry?.estimate;
  if (est && Number.isFinite(Number(est.pct))) {
    const raw = Number.isFinite(Number(est.raw_pct)) ? ` The raw financial-institution plus foreign-corporation share is ${Number(est.raw_pct).toFixed(1)}%.` : '';
    const excluded = est.excluded || 'That estimate excludes retail custody and nominee accounts (Charles Schwab FBO, National Financial Services, Interactive Brokers, and Morgan Stanley Smith Barney) and the CEO\'s MMXX Ventures.';
    const when = /^(\d{4})-(\d{2})-(\d{2})$/.test(est.as_of || '')
      ? `${MONTHS_SHORT[Number(est.as_of.slice(5, 7)) - 1]} ${Number(est.as_of.slice(8, 10))}, ${est.as_of.slice(0, 4)}`
      : (est.as_of || 'the report date');
    notes.push(`Estimated institutional (owner-type table, ${when}): ~${Number(est.pct).toFixed(1)}%.${raw} ${excluded}`);
  }
  const ins = entry?.insiders;
  if (ins && ins.text) notes.push(ins.text);
  return notes;
}

export function buildOwnershipView(entry, basicShares, now = new Date()) {
  if (!entry || typeof entry !== 'object') return null;
  const basic = Number(basicShares);
  const basicOk = Number.isFinite(basic) && basic > 0 ? basic : null;
  const owners = mergeOwners(entry.positions, entry.beneficial).map((h) => viewHolder(h, basicOk, now));
  const register = (entry.register || []).map((h) => viewHolder(h, basicOk, now));
  const pool = [...owners, ...register].filter((h) => h.shares > 0 && h.pct != null);
  const above = pool.filter((h) => h.above).sort((a, b) => b.shares - a.shares);
  const fallback = above.length === 0;
  const ranked = pool.slice().sort((a, b) => b.shares - a.shares);
  const holders = fallback ? ranked.slice(0, 3) : above;
  const notes = [...(entry.notes || [])];
  if (entry.last_error && entry.fetched_at) {
    notes.unshift(`The latest refresh failed (${entry.last_error}). These are the saved figures from ${entry.fetched_at.slice(0, 10)}.`);
  }
  if (entry.reported !== false) {
    const dates = new Set((entry.positions || []).map((p) => p.as_of).filter(Boolean));
    if (dates.size > 1) {
      notes.push('The institutional total adds 13F positions that are not all from the same quarter. Each holder below keeps its own as-of date.');
    }
    notes.push(...familyNotes(entry.positions, holders, basicOk));
    for (const b of entry.beneficial || []) {
      const key = normalizeHolderName(b.name);
      const kept = owners.find((o) => normalizeHolderName(o.name) === key);
      if (kept && kept.source !== b.source && (kept.as_of || '') >= (b.as_of || '')) continue;
      const pct = holderPct(b.shares, basicOk);
      if (pct == null || pct > 5 || pct < 2) continue;
      if (holders.some((h) => normalizeHolderName(h.name) === key)) continue;
      notes.push(`${b.name}'s ${b.source} reports ${b.shares.toLocaleString('en-US')} shares as of ${b.as_of || 'an unknown date'}, which is ${pct.toFixed(1)}% of current basic shares, so it is not listed.`);
    }
    for (const b of entry.beneficial || []) {
      if (!b.joint_names?.length) continue;
      const key = normalizeHolderName(b.name);
      if (!holders.some((h) => normalizeHolderName(h.name) === key)) continue;
      const listed = b.joint_names.slice(0, 8).join(', ');
      const more = b.joint_names.length > 8 ? `, and ${b.joint_names.length - 8} more` : '';
      notes.push(`${b.name}'s ${b.source} reports the same ${b.shares.toLocaleString('en-US')} shares for ${listed}${more}. Those names were not added together.`);
    }
  }
  const supplements = supplementalOwnershipNotes(entry);
  notes.push(...supplements);
  if (entry.floor && Number.isFinite(Number(entry.floor.pct))) {
    const floor = entry.floor;
    return {
      reported: true,
      floor: true,
      pct: Number(floor.pct),
      institutional_shares: Number.isInteger(floor.shares) ? floor.shares : null,
      basic_shares: basicOk,
      as_of: floor.as_of || null,
      as_of_label: floor.label || '',
      floor_detail: floorDetail(floor),
      source: floor.source || entry.source || null,
      source_url: floor.url || entry.source_url || null,
      holders,
      above_5: above.length > 0,
      fallback_top: fallback && holders.length > 0,
      notes,
      fetched_at: entry.fetched_at || null,
      unavailable: false,
    };
  }
  if (entry.reported === false) {
    return {
      reported: false,
      reason: entry.reason || JP_REASON,
      as_of: entry.as_of || register.find((h) => h.as_of)?.as_of || null,
      as_of_label: '',
      source: entry.source || null,
      source_url: entry.source_url || null,
      holders,
      above_5: above.length > 0,
      fallback_top: fallback && holders.length > 0,
      notes,
      fetched_at: entry.fetched_at || null,
      unavailable: entry.ok === false && !holders.length && !(entry.notes || []).length,
    };
  }
  const shares = Number.isInteger(entry.institutional_shares) ? entry.institutional_shares : null;
  const pct = shares != null && basicOk ? shares / basicOk * 100 : null;
  if (entry.ok === false && shares == null) {
    return {
      reported: true,
      unavailable: true,
      reason: entry.last_error || 'Institutional ownership is unavailable.',
      holders: [],
      notes,
      above_5: false,
      fallback_top: false,
      fetched_at: entry.fetched_at || null,
    };
  }
  return {
    reported: true,
    unavailable: false,
    pct,
    institutional_shares: shares,
    holders_count: entry.holders_count ?? null,
    basic_shares: basicOk,
    as_of: entry.as_of || null,
    as_of_label: ownershipSubtext(entry.as_of, '13F', now),
    source: entry.source || 'Form 13F',
    source_url: entry.source_url || null,
    holders,
    above_5: above.length > 0,
    fallback_top: fallback && holders.length > 0,
    notes,
    fetched_at: entry.fetched_at || null,
  };
}

export function formatOwnershipLog(view) {
  if (!view) return 'n/a';
  if (view.unavailable) return `unavailable (${view.reason || 'no data'})`;
  if (view.reported === false) {
    const list = (view.holders || []).map((h) => `${h.name} ${h.shares} ${h.pct?.toFixed(1)}% ${h.group} ${h.as_of || ''} [${h.source}]`).join('; ');
    return `not reported | ${list || 'no >5% holder'} | ${(view.notes || []).length} notes`;
  }
  const list = (view.holders || []).map((h) => `${h.name} ${h.shares} ${h.pct?.toFixed(1)}% ${h.as_of || ''} [${h.source}]`).join('; ');
  const pct = view.pct == null ? 'n/a' : `${view.pct.toFixed(1)}%`;
  return `${pct} as of ${view.as_of || 'unknown'} (${view.institutional_shares ?? 'n/a'} / ${view.basic_shares ?? 'n/a'}) | ${view.fallback_top ? 'top 3' : '>5%'} ${list}`;
}

async function secFetch(url) {
  const wait = secNotBefore - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  secNotBefore = Date.now() + SEC_MIN_INTERVAL_MS;
  const r = await fetch(url, {
    headers: { 'User-Agent': SEC_UA, Accept: 'application/json,text/html,application/xml,*/*' },
    signal: AbortSignal.timeout(25000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return text;
}

function padCik(cik) {
  const digits = String(cik ?? '').trim().replace(/^CIK/i, '');
  if (!/^\d{1,10}$/.test(digits)) throw new Error(`invalid CIK ${cik}`);
  return digits.padStart(10, '0');
}

function filingArchiveUrl(cik, adsh, filename) {
  const acc = String(adsh || '').replace(/-/g, '');
  if (!/^\d{18}$/.test(acc) || !filename || /[/\\]/.test(filename)) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(padCik(cik))}/${acc}/${filename}`;
}

async function searchBeneficialFilings(cik, now) {
  const end = now.toISOString().slice(0, 10);
  const start = `${now.getUTCFullYear() - 3}-01-01`;
  const params = new URLSearchParams({
    ciks: padCik(cik),
    forms: 'SC 13G,SC 13G/A,SC 13D,SC 13D/A',
    dateRange: 'custom',
    startdt: start,
    enddt: end,
  });
  const text = await secFetch(`https://efts.sec.gov/LATEST/search-index?${params}`);
  const data = JSON.parse(text);
  if (data?.errorType) throw new Error(data.errorMessage || data.errorType);
  const hits = data?.hits?.hits || [];
  const subject = padCik(cik);
  const latest = new Map();
  for (const hit of hits) {
    const src = hit?._source;
    if (!src?.adsh || !src.file_date) continue;
    const ciks = (src.ciks || []).map((c) => {
      try { return padCik(c); } catch { return ''; }
    }).filter(Boolean);
    const filerCik = ciks.find((c) => c !== subject) || ciks[0];
    if (!filerCik) continue;
    const prev = latest.get(filerCik);
    if (prev && prev.file_date >= src.file_date) continue;
    const names = src.display_names || [];
    const filerName = names.map((n) => String(n)).find((n) => !n.includes(`CIK ${subject}`) && !n.includes(`CIK ${Number(subject)}`))
      || names[1]
      || names[0]
      || '';
    const cleaned = filerName.replace(/\s*\(CIK\s+\d+\)\s*/gi, '').replace(/\s+/g, ' ').trim();
    latest.set(filerCik, {
      filerCik,
      filerName: cleaned,
      adsh: src.adsh,
      file_date: src.file_date,
      form: src.form || 'SC 13G',
    });
  }
  return [...latest.values()];
}

async function readFiling(hit) {
  const acc = hit.adsh.replace(/-/g, '');
  const index = JSON.parse(await secFetch(`https://www.sec.gov/Archives/edgar/data/${Number(hit.filerCik)}/${acc}/index.json`));
  const items = index?.directory?.item || [];
  const names = items.map((i) => i.name).filter(Boolean);
  const doc = pickFilingDocument(names, hit.adsh);
  if (!doc) throw new Error(`no document in ${hit.adsh}`);
  const url = filingArchiveUrl(hit.filerCik, hit.adsh, doc);
  const body = await secFetch(url);
  return { body, url };
}

async function fetchBeneficial(cik, basicShares, now) {
  const hits = await searchBeneficialFilings(cik, now);
  const out = [];
  for (const hit of hits) {
    try {
      const { body, url } = await readFiling(hit);
      const holder = parse13DGDocument(body, {
        basicShares,
        filingDate: hit.file_date,
        form: hit.form,
        url,
        filerName: hit.filerName,
      });
      if (holder) out.push(holder);
      else {
        const plain = htmlToText(body);
        const readShares = /AGGREGATE AMOUNT BENEFICIALLY OWNED BY EACH REPORTING PERSON\s*[\d,]/i.test(plain)
          || /<aggregateAmountOwned>\s*[\d,]/i.test(body);
        if (!readShares) console.warn(`13D/13G ${hit.adsh}: could not read a share count from ${url}`);
      }
    } catch (e) {
      console.warn(`13D/13G ${hit.adsh}: ${e.message}`);
    }
  }
  return out;
}

async function fetchNasdaq(ticker) {
  const url = `https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/institutional-holdings?limit=25&type=TOTAL&sortColumn=sharesHeld&sortOrder=desc`;
  const r = await fetch(url, {
    headers: { 'User-Agent': PAGE_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`Nasdaq HTTP ${r.status}`);
  const parsed = parseNasdaqHoldings(await r.json());
  if (parsed.institutional_shares == null) throw new Error('Nasdaq response had no institutional total');
  parsed.source = 'Nasdaq institutional holdings (Form 13F)';
  parsed.source_url = `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(ticker)}/institutional-holdings`;
  return parsed;
}

async function pdfTo(buffer, mode) {
  const dir = await mkdtemp(path.join(tmpdir(), 'own-'));
  const file = path.join(dir, 'doc.pdf');
  try {
    await writeFile(file, buffer);
    const args = mode === 'tsv' ? ['-tsv', file, '-'] : ['-layout', file, '-'];
    const { stdout } = await execFileAsync('pdftotext', args, { maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fetchPdf(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': PAGE_UA, Accept: 'application/pdf,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 5 || buf.subarray(0, 4).toString() !== '%PDF') throw new Error(`not a PDF (${url})`);
  return buf;
}

export function metaplanetPdfUrl(disclosure) {
  if (disclosure?.url && /^https:\/\/(www\.)?metaplanet\.jp\//.test(disclosure.url)) return disclosure.url;
  const bare = String(disclosure?.id || '').replace(/\.pdf$/i, '');
  if (!/^[A-Za-z0-9-]{6,80}$/.test(bare)) return null;
  return `https://metaplanet.jp/disclosure-pdf/${bare}.pdf`;
}

function isMajorNotice(d) {
  return d?.english === true && /major shareholder/i.test(d.title || '') && /change/i.test(d.title || '');
}

function reportRank(d) {
  const m = String(d?.title || '').match(/(\d{4})\/(\d{2})\/(\d{2})/);
  return `${m ? m[1] + m[2] + m[3] : '00000000'}-${d?.date || ''}`;
}

function latestShareholderReport(disclosures) {
  const rows = (disclosures || []).filter((d) => /(?:訂正)?(?:半期報告書|有価証券報告書)/.test(d.title || ''));
  rows.sort((a, b) => (reportRank(a) < reportRank(b) ? 1 : reportRank(a) > reportRank(b) ? -1 : 0));
  return rows[0] || null;
}

async function fetchMetaplanet(disclosures) {
  if (!disclosures?.length) throw new Error('disclosures were not available');
  const notices = disclosures.filter(isMajorNotice).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, 6);
  const beneficial = [];
  const seen = new Set();
  for (const notice of notices) {
    const url = metaplanetPdfUrl(notice);
    if (!url) continue;
    const text = await pdfTo(await fetchPdf(url), 'layout');
    const parsed = parseMajorShareholderNotice(text);
    if (!parsed) {
      console.warn(`Could not parse major-shareholder notice ${notice.date} ${notice.id}`);
      continue;
    }
    const key = normalizeHolderName(parsed.name);
    if (seen.has(key)) continue;
    seen.add(key);
    beneficial.push({
      ...parsed,
      url,
      notice_date: notice.date,
      notice_title: notice.title,
      source: `Major shareholder notice ${notice.date}`,
    });
  }
  const report = latestShareholderReport(disclosures);
  let register = [];
  let registerAsOf = null;
  const notes = [];
  if (report) {
    const url = metaplanetPdfUrl(report);
    if (!url) throw new Error('shareholder report had no PDF link');
    const buf = await fetchPdf(url);
    const [tsv, layout] = await Promise.all([pdfTo(buf, 'tsv'), pdfTo(buf, 'layout')]);
    const parsed = parseRegisterHolders(tsv);
    registerAsOf = parsed.as_of;
    register = parsed.holders.map((h) => ({ ...h, url }));
    notes.push(...parseUnconfirmedNotes(layout));
    if (/Ｂ種種類株式が含まれております|B種種類株式が含まれております/.test(normalizeWidth(layout))) {
      notes.push('The shareholder-register counts include Class B preferred shares, which do not vote. Several names are standing proxies for custody accounts, not confirmed beneficial owners, and they are not added to the large-shareholding figures.');
    }
    notes.push(`EDINET is not queried directly. Figures are from Metaplanet's disclosures, which cite the large-shareholding reports. Register source: ${report.title} (${report.date}).`);
  } else {
    notes.push('No semiannual or annual securities report was found on the disclosures page.');
  }
  if (!beneficial.length) notes.unshift('No major-shareholder notice could be parsed.');
  return {
    reported: false,
    reason: JP_REASON,
    source: 'Metaplanet disclosures (no 13F)',
    source_url: 'https://metaplanet.jp/en/shareholders/disclosures',
    as_of: registerAsOf,
    positions: [],
    beneficial,
    register,
    notes,
    report_id: report?.id || null,
    notice_ids: notices.map((n) => n.id),
  };
}

function stampFailure(prev, kind, message, nowIso) {
  const base = prev && typeof prev === 'object' ? { ...prev } : {};
  base.attempted_at = nowIso;
  base.last_error = message;
  if (kind === 'jp') {
    base.reported = false;
    base.reason = base.reason || JP_REASON;
    if (!base.fetched_at) base.ok = false;
  } else if (base.institutional_shares == null) {
    base.ok = false;
    base.reported = true;
  }
  return base;
}

async function refreshOne(task, prev, disclosures, now) {
  const nowIso = now.toISOString();
  if (task.kind === 'jp') {
    const fresh = await fetchMetaplanet(disclosures);
    // Hand-maintained floor, estimate, and insider figures survive a refresh.
    // fetchMetaplanet rebuilds holders and notes; these fields are not in the PDFs it parses.
    const kept = {};
    for (const key of ['floor', 'estimate', 'insiders']) {
      if (prev && prev[key] && typeof prev[key] === 'object') kept[key] = prev[key];
    }
    return { ...fresh, ...kept, ok: true, fetched_at: nowIso, attempted_at: nowIso, last_error: null };
  }
  if (task.kind !== 'us') {
    return {
      ok: true,
      reported: false,
      reason: 'No institutional-ownership source is configured for this company.',
      positions: [],
      beneficial: [],
      register: [],
      notes: [],
      fetched_at: nowIso,
      attempted_at: nowIso,
    };
  }
  const nasdaq = await fetchNasdaq(task.ticker);
  let beneficial = [];
  let note = null;
  if (task.cik) {
    try {
      beneficial = await fetchBeneficial(task.cik, task.basicShares, now);
    } catch (e) {
      beneficial = prev?.beneficial || [];
      note = `Schedule 13D/13G could not be refreshed (${e.message}). Earlier 13D/13G rows are unchanged.`;
    }
  }
  const notes = note ? [note] : [];
  return {
    ok: true,
    reported: true,
    institutional_shares: nasdaq.institutional_shares,
    holders_count: nasdaq.holders_count,
    as_of: nasdaq.as_of,
    source: nasdaq.source,
    source_url: nasdaq.source_url,
    positions: nasdaq.positions,
    beneficial,
    register: [],
    notes,
    fetched_at: nowIso,
    attempted_at: nowIso,
    last_error: null,
  };
}

export async function refreshOwnershipCache(cache, tasks, { disclosures, now = new Date() } = {}) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = { companies: {} };
  if (!cache.companies || typeof cache.companies !== 'object' || Array.isArray(cache.companies)) cache.companies = {};
  const errors = [];
  let dirty = false;
  for (const task of tasks || []) {
    if (!task?.id) continue;
    const prev = cache.companies[task.id];
    if (!shouldRefreshOwnership(prev, now)) continue;
    try {
      cache.companies[task.id] = await refreshOne(task, prev, disclosures, now);
      dirty = true;
    } catch (e) {
      cache.companies[task.id] = stampFailure(prev, task.kind, e.message, now.toISOString());
      dirty = true;
      const kept = cache.companies[task.id].institutional_shares != null || (cache.companies[task.id].beneficial || []).length || (cache.companies[task.id].register || []).length;
      errors.push(`${task.name || task.id} ownership: ${e.message}${kept ? ' (showing the last saved figures)' : ''}`);
    }
  }
  return { cache, dirty, errors };
}

export async function loadOwnership(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('ownership cache was not an object');
    if (!data.companies || typeof data.companies !== 'object' || Array.isArray(data.companies)) data.companies = {};
    return data;
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return {
        _readme: 'Last good institutional-ownership fetch per company. scripts/update.mjs refreshes a company when attempted_at is at least 20 hours old. A failed fetch keeps the previous figures and still updates attempted_at so the next run does not retry immediately. The page divides institutional_shares by the current basic shares; it does not store a third-party percent.',
        companies: {},
      };
    }
    throw e;
  }
}

export async function saveOwnership(file, cache) {
  if (!cache._readme) {
    cache._readme = 'Last good institutional-ownership fetch per company. Refreshed at most about once a day. A failed fetch keeps these figures.';
  }
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`);
}
