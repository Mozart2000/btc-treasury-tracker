import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newestTdnetCitation, topicsOf, formatTopicList, metaplanetNote,
  safePdfUrl, disclosurePdfUrl, parseMetaplanetDisclosures, newestDisclosure,
  metaplanetFilingStatusFromDisclosures, filingSpec,
} from './update.mjs';

const cebeSource = 'TDnet 140120261005546274 (English; Japanese original 140120261005546273), Notice of Additional Purchase of Bitcoin, disclosed 2026-10-05, for BTC holdings 44,000, fully diluted shares and the filed net of JPY 122,374M in net claims; TDnet 140120261001544425, 2026-10-01, for shares net of treasury at 2026-09-30; debt and preferred carried from the 2026-06-30 basis, H1 FY2026 kessan tanshin TDnet 140120260812518571, EST; cash from that basis plus the filed flows to 2026-09-30, floored at zero, EST; the bitcoin price per the CoinGecko D+1 close convention';

function flight(payload) {
  return `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
}

const sample = [
  {
    id: '140120261013550092.pdf',
    date: '2026-10-14',
    title: '自己株式立会外買付取引による自己株式の取得結果に関するお知らせ',
    filePath: 'https://contents.xj-storage.jp/xcontents/33500/a/140120261013550092.pdf',
    isEnglish: false,
  },
  {
    id: '140120261014550251.pdf',
    date: '2026-10-14',
    title: 'Notice Regarding the Result of Share Repurchases through Off-Auction Own Share Repurchase Trading (ToSTNeT-3)',
    filePath: 'https://contents.xj-storage.jp/xcontents/33500/b/140120261014550251.pdf',
    isEnglish: true,
  },
  {
    id: '140120261014549809.pdf',
    date: '2026-10-14',
    title: 'Notice on Determination of Terms of Issue of Zero Coupon Euro-Yen Denominated Convertible Bonds with Stock Acquisition Rights due 2031',
    filePath: 'https://contents.xj-storage.jp/xcontents/33500/c/140120261014549809.pdf',
    isEnglish: true,
  },
  {
    id: '140120261013550035.pdf',
    date: '2026-10-13',
    title: 'Supplementary Materials on the Issuance of Euro-Yen Convertible Bonds and Share Repurchase',
    filePath: 'https://evil.example/not-a-pdf',
    isEnglish: true,
  },
  {
    id: '140120261005546274.pdf',
    date: '2026-10-05',
    title: 'Notice of Additional Purchase of Bitcoin (Including Sale and Reacquisition of Bitcoin to Demonstrate Liquidity)',
    filePath: 'https://metaplanet.jp/disclosure/en/140120261005546274.pdf',
    isEnglish: true,
  },
  {
    id: 'routine.pdf',
    date: '2026-10-06',
    title: 'Notice Regarding the Change of Address',
    filePath: 'https://contents.xj-storage.jp/xcontents/33500/d/routine.pdf',
    isEnglish: true,
  },
];

function page(rows) {
  const head = 'ignored "disclosures":"Disclosures" ';
  const body = `${head}"disclosures":${JSON.stringify(rows)}`;
  const mid = Math.floor(body.length / 2);
  return flight(body.slice(0, mid)) + flight(body.slice(mid));
}

test('newest TDnet id date ignores older ids and later prose dates', () => {
  const cited = newestTdnetCitation(cebeSource);
  assert.equal(cited.id, '140120261005546274');
  assert.equal(cited.date, '2026-10-05');
  const withLaterProse = `${cebeSource} A shareholder meeting is set for December 1, 2026.`;
  assert.equal(newestTdnetCitation(withLaterProse).date, '2026-10-05');
  assert.equal(newestTdnetCitation('no ids, disclosed 2026-10-14'), null);
  assert.equal(newestTdnetCitation('TDnet 140120261302000000'), null);
  assert.equal(newestTdnetCitation('accession 000119312526424688'), null);
});

test('parses the flight payload, not the HTML table', () => {
  const html = `<table><tr><td>Oct 14, 2026</td><td>Ignored table title</td></tr></table>${page(sample)}`;
  const rows = parseMetaplanetDisclosures(html);
  assert.equal(rows.length, sample.length);
  assert.equal(rows[1].english, true);
  assert.equal(rows[1].date, '2026-10-14');
  assert.equal(rows[1].url, 'https://contents.xj-storage.jp/xcontents/33500/b/140120261014550251.pdf');
  assert.equal(rows[3].url, 'https://metaplanet.jp/disclosure-pdf/140120261013550035.pdf');
  assert.equal(newestDisclosure(rows).title, rows[1].title);
});

test('flags disclosures dated after the cited TDnet id and names material topics', () => {
  const rows = parseMetaplanetDisclosures(page(sample));
  const filing = metaplanetFilingStatusFromDisclosures(rows, cebeSource, '2026-09-30');
  assert.equal(filing.status, 'newer');
  assert.equal(filing.cebe_reference, 'tdnet');
  assert.equal(filing.cebe_reference_date, '2026-10-05');
  assert.equal(filing.cebe_tdnet_id, '140120261005546274');
  assert.equal(filing.filing_date, '2026-10-14');
  assert.match(filing.title, /Share Repurchases/);
  assert.equal(filing.material, true);
  assert.equal(filing.newer_count, 4);
  assert.deepEqual(filing.topics, ['convertible bonds', 'share repurchases']);
  assert.equal(
    filing.note,
    '4 newer disclosures since Oct 5, including convertible bonds and share repurchases — data may not reflect them yet',
  );
  assert.ok(filing.newer.some((d) => /Convertible Bonds with Stock Acquisition Rights due 2031/.test(d.title)));
  assert.ok(filing.newer.some((d) => d.date === '2026-10-13' && d.url.endsWith('140120261013550035.pdf')));
  assert.ok(!filing.newer.some((d) => /自己株式/.test(d.title)));
  assert.ok(!filing.newer.some((d) => d.date === '2026-10-05'));
});

test('same TDnet date is up to date, and a missing id falls back to as-of', () => {
  const rows = parseMetaplanetDisclosures(page(sample.filter((d) => d.date <= '2026-10-05')));
  const current = metaplanetFilingStatusFromDisclosures(rows, cebeSource, '2026-09-30');
  assert.equal(current.status, 'current');
  assert.equal(current.note, 'Up to date');
  assert.equal(current.newer_count, 0);
  assert.match(current.title, /Additional Purchase of Bitcoin/);

  const fallback = metaplanetFilingStatusFromDisclosures(
    rows,
    'disclosed 2026-10-14 but no TDnet id',
    '2026-09-30',
  );
  assert.equal(fallback.cebe_reference, 'as_of');
  assert.equal(fallback.cebe_reference_date, '2026-09-30');
  assert.equal(fallback.status, 'newer');
  assert.equal(fallback.cebe_tdnet_id, null);
});

test('a Japanese-only later date still flags', () => {
  const rows = parseMetaplanetDisclosures(page([
    sample[0],
    sample[4],
  ]));
  const filing = metaplanetFilingStatusFromDisclosures(rows, cebeSource, '2026-09-30');
  assert.equal(filing.status, 'newer');
  assert.equal(filing.newer_count, 1);
  assert.match(filing.title, /自己株式/);
  assert.equal(filing.note, 'New disclosure Oct 14, including share repurchases — data may not reflect it yet');
});

test('material titles are distinguished from routine ones', () => {
  assert.deepEqual(topicsOf('Notice of Additional Purchase of Bitcoin'), ['bitcoin purchases']);
  assert.deepEqual(topicsOf('Notice Regarding Issuance of Preferred Shares'), ['share issuance', 'preferred']);
  assert.deepEqual(topicsOf('Notice Regarding the Q3 Results of the Bitcoin Income Generation Business'), []);
  assert.deepEqual(topicsOf('Notice Regarding Further Revision of Capital Allocation Policy'), []);
  assert.equal(formatTopicList(['convertible bonds', 'share repurchases']), 'convertible bonds and share repurchases');
  assert.equal(formatTopicList(['bitcoin purchases']), 'bitcoin purchases');
  assert.equal(
    metaplanetNote({ status: 'unknown', count: 0, referenceDate: null, filingDate: null, topics: [] }),
    'Could not compare to CEBE date',
  );
});

test('pdf links stay on Metaplanet or the TDnet host', () => {
  assert.equal(safePdfUrl('https://contents.xj-storage.jp/xcontents/33500/a/140120261014549809.pdf'), 'https://contents.xj-storage.jp/xcontents/33500/a/140120261014549809.pdf');
  assert.equal(safePdfUrl('https://metaplanet.jp/disclosure/en/note.pdf'), 'https://metaplanet.jp/disclosure/en/note.pdf');
  assert.equal(safePdfUrl('https://evil.example/140120261014549809.pdf'), null);
  assert.equal(safePdfUrl('http://metaplanet.jp/disclosure-pdf/140120261014549809.pdf'), null);
  assert.equal(safePdfUrl('https://user:pass@metaplanet.jp/a.pdf'), null);
  assert.equal(safePdfUrl('https://metaplanet.jp/../../etc/passwd'), null);
  assert.equal(
    disclosurePdfUrl('not a url', '140120261014549809.pdf'),
    'https://metaplanet.jp/disclosure-pdf/140120261014549809.pdf',
  );
  assert.equal(disclosurePdfUrl('https://evil.example/x.pdf', 'notice'), null);
});

test('filings config selects sec or metaplanet, and sec_cik still works', () => {
  assert.deepEqual(filingSpec({ filings: { source: 'sec', cik: '0001050446' } }), {
    source: 'sec', cik: '0001050446', ticker: '',
  });
  assert.equal(filingSpec({ sec_cik: '0001920406', sec_ticker: 'ASST' }).source, 'sec');
  assert.equal(filingSpec({ filings: { type: 'tdnet' } }).url, 'https://metaplanet.jp/en/shareholders/disclosures');
  assert.equal(filingSpec({ filings: { source: 'metaplanet', url: 'https://example.test/x' } }).url, 'https://example.test/x');
  assert.equal(filingSpec({ name: 'Other' }), null);
  assert.throws(() => filingSpec({ filings: { source: 'edinet' } }), /unknown filings source/);
});

test('parser rejects a page with no payload', () => {
  assert.throws(() => parseMetaplanetDisclosures('<html><table><td>Oct 14, 2026</td></table></html>'), /no data payload/);
});
