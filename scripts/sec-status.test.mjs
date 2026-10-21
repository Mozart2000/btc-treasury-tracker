import test from 'node:test';
import assert from 'node:assert/strict';
import {
  padCik, datesInText, sourceCitesAccession, compareToCebe, secNote,
  filingUrl, latestFiling, formatMonthDay, formatMonthDayYear,
} from './update.mjs';

const mstrSource = '8-K filed 2026-10-19, acc 0001193125-26-424688, covering 2026-10-12 to 2026-10-18. Debt carried from the 2026-06-30 balance (Q2 10-Q acc 0001050446-26-000044, all-principal basis); no debt event in this 8-K.';
const asstSource = '8-K Oct 20, 2026 (acc 0000950103-26-015849), SATS closing, Items 3.03 and 8.01; holdings, shares, STRC and cash base from 8-K Oct 19, 2026 (acc 0001628280-26-066222), as of Oct 16, 2026; SATS net proceeds from 424B5 Oct 16, 2026 (acc 0000950103-26-015734). EDGAR VERIFIED: https://www.sec.gov/Archives/edgar/data/1920406/000095010326015849/dp255260_8k.htm';

test('pads and rejects CIKs', () => {
  assert.equal(padCik('1050446'), '0001050446');
  assert.equal(padCik('CIK0001920406'), '0001920406');
  assert.equal(padCik(1920406), '0001920406');
  assert.throws(() => padCik('MSTR'), /invalid CIK/);
  assert.throws(() => padCik(''), /invalid CIK/);
});

test('parses filing dates without timezone shift', () => {
  assert.deepEqual(datesInText(mstrSource).sort(), ['2026-06-30', '2026-10-12', '2026-10-18', '2026-10-19']);
  assert.ok(datesInText(asstSource).includes('2026-10-20'));
  assert.ok(datesInText('disclosed 15 Oct 2026').includes('2026-10-15'));
  assert.ok(datesInText('August 10, 2026').includes('2026-08-10'));
  assert.deepEqual(datesInText('Items 3.03 and 8.01'), []);
  assert.deepEqual(datesInText('2026-02-31'), []);
  assert.equal(formatMonthDay('2026-10-22'), 'Oct 22');
  assert.equal(formatMonthDayYear('2026-10-19'), 'Oct 19, 2026');
});

test('accession citation matches dashed and undashed forms', () => {
  assert.equal(sourceCitesAccession(mstrSource, '0001193125-26-424688'), true);
  assert.equal(sourceCitesAccession(asstSource, '0000950103-26-015849'), true);
  assert.equal(sourceCitesAccession(asstSource, '000095010326015849'), true);
  assert.equal(sourceCitesAccession(mstrSource, '0001193125-26-999999'), false);
});

test('CEBE is current when it already cites the filing', () => {
  const cmp = compareToCebe(
    { accession: '0001193125-26-424688', filingDate: '2026-10-21' },
    mstrSource,
    '2026-10-18',
  );
  assert.equal(cmp.status, 'current');
  assert.equal(cmp.reference, 'accession');
});

test('a later uncited filing is newer than the CEBE source date', () => {
  const cmp = compareToCebe(
    { accession: '0001193125-26-999999', filingDate: '2026-10-22' },
    mstrSource,
    '2026-10-18',
  );
  assert.equal(cmp.status, 'newer');
  assert.equal(cmp.reference, 'source');
  assert.equal(cmp.referenceDate, '2026-10-19');
  assert.equal(secNote('8-K', '2026-10-22', 'newer'), 'New 8-K filed Oct 22 — data may not reflect it yet');
});

test('same filing date as the CEBE source is up to date', () => {
  const cmp = compareToCebe(
    { accession: '0000950103-26-000001', filingDate: '2026-10-20' },
    asstSource,
    '2026-10-20',
  );
  assert.equal(cmp.status, 'current');
  assert.equal(secNote('8-K', '2026-10-20', 'current'), 'Up to date');
});

test('falls back to the as-of date when the source has no dates', () => {
  const newer = compareToCebe({ accession: '0001193125-26-999999', filingDate: '2026-10-19' }, 'no dates here', '2026-10-18');
  assert.equal(newer.status, 'newer');
  assert.equal(newer.reference, 'as_of');
  const same = compareToCebe({ accession: '0001193125-26-999999', filingDate: '2026-10-18' }, '', '2026-10-18');
  assert.equal(same.status, 'current');
  assert.equal(same.reference, 'as_of');
  const unknown = compareToCebe({ accession: '0001193125-26-999999', filingDate: '2026-10-18' }, '', null);
  assert.equal(unknown.status, 'unknown');
});

test('builds a sec.gov document link and ignores unsafe names', () => {
  assert.equal(
    filingUrl('0001920406', '0000950103-26-015849', 'dp255260_8k.htm'),
    'https://www.sec.gov/Archives/edgar/data/1920406/000095010326015849/dp255260_8k.htm',
  );
  assert.equal(
    filingUrl('1050446', '0001193125-26-424688', ''),
    'https://www.sec.gov/Archives/edgar/data/1050446/0001193125-26-424688-index.html',
  );
  assert.equal(
    filingUrl('1050446', '0001193125-26-424688', '../etc/passwd'),
    'https://www.sec.gov/Archives/edgar/data/1050446/0001193125-26-424688-index.html',
  );
});

test('picks the latest 8-K, 10-Q, or 10-K and skips other forms', () => {
  const sub = {
    filings: {
      recent: {
        form: ['4', '8-K', '10-Q', '8-K/A', 'S-3'],
        filingDate: ['2026-10-22', '2026-10-21', '2026-10-21', '2026-10-18', '2026-10-25'],
        acceptanceDateTime: ['2026-10-22T12:00:00.000Z', '2026-10-21T15:00:00.000Z', '2026-10-21T21:00:00.000Z', '2026-10-18T12:00:00.000Z', '2026-10-25T12:00:00.000Z'],
        accessionNumber: ['0000000000-26-000001', '0000000000-26-000002', '0000000000-26-000003', '0000000000-26-000004', '0000000000-26-000005'],
        primaryDocument: ['a.xml', 'b.htm', 'c.htm', 'd.htm', 'e.htm'],
      },
    },
  };
  const filing = latestFiling(sub);
  assert.equal(filing.form, '10-Q');
  assert.equal(filing.filingDate, '2026-10-21');
  assert.equal(filing.accession, '0000000000-26-000003');
});
