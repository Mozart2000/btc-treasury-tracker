import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNasdaqHoldings, parse13DGDocument, filingMatchesShareBase, parseMajorShareholderNotice,
  parseRegisterHolders, parseUnconfirmedNotes, normalizeHolderName, shouldRefreshOwnership,
  buildOwnershipView, ownershipSubtext, familyNotes, pickFilingDocument,
} from './ownership.mjs';

const BASIC = 422259821;

test('institutional percent uses the page share count, not Nasdaq percent', () => {
  const parsed = parseNasdaqHoldings({
    data: {
      ownershipSummary: { SharesOutstandingPCT: { value: '58.18%' } },
      activePositions: {
        rows: [
          { positions: 'Total Institutional Shares', holders: '1,078', shares: '234,146,230' },
        ],
      },
      holdingsTransactions: {
        totalRecords: '1078',
        table: {
          rows: [
            { ownerName: 'Capital International Investors', date: '6/30/2026', sharesHeld: '34,902,002', url: '/market-activity/institutional-portfolio/capital-international-investors-893016' },
            { ownerName: 'Vanguard Group Inc', date: '12/31/2025', sharesHeld: '24,062,886', url: 'https://evil.example/v' },
            { ownerName: 'Blackrock, Inc.', date: '6/30/2026', sharesHeld: '19,394,284' },
            { ownerName: 'Vanguard Portfolio Management Llc', date: '6/30/2026', sharesHeld: '15,353,408' },
          ],
        },
      },
    },
  });
  assert.equal(parsed.institutional_shares, 234146230);
  assert.equal(parsed.holders_count, 1078);
  assert.equal(parsed.as_of, '2026-06-30');
  assert.equal(parsed.positions[0].url, 'https://www.nasdaq.com/market-activity/institutional-portfolio/capital-international-investors-893016');
  assert.equal(parsed.positions[1].url, null);
  const view = buildOwnershipView({
    reported: true,
    ok: true,
    ...parsed,
    beneficial: [],
    notes: [],
  }, BASIC, new Date('2026-10-27T00:00:00Z'));
  assert.equal(view.as_of_label, '13F Jun 30');
  assert.ok(Math.abs(view.pct - (234146230 / BASIC * 100)) < 1e-9);
  assert.equal(view.above_5, true);
  assert.deepEqual(view.holders.map((h) => h.name), ['Capital International Investors', 'Vanguard Group Inc']);
  assert.ok(view.notes.some((n) => n.startsWith('Vanguard reports under several entities')));
  assert.ok(view.notes.some((n) => n.includes('not all from the same quarter')));
});

test('no holder above 5% lists the top 3', () => {
  const view = buildOwnershipView({
    reported: true,
    ok: true,
    institutional_shares: 100,
    holders_count: 3,
    as_of: '2025-12-31',
    positions: [
      { name: 'One', shares: 40, as_of: '2025-12-31', source: 'Form 13F', group: 'owners' },
      { name: 'Two', shares: 30, as_of: '2025-12-31', source: 'Form 13F', group: 'owners' },
      { name: 'Three', shares: 20, as_of: '2025-12-31', source: 'Form 13F', group: 'owners' },
      { name: 'Four', shares: 10, as_of: '2025-12-31', source: 'Form 13F', group: 'owners' },
    ],
    beneficial: [],
    notes: [],
  }, 10000, new Date('2026-10-27T00:00:00Z'));
  assert.equal(view.fallback_top, true);
  assert.deepEqual(view.holders.map((h) => h.name), ['One', 'Two', 'Three']);
  assert.equal(view.as_of_label, '13F Dec 31, 2025');
  assert.equal(ownershipSubtext('2025-12-31', '13F', new Date('2025-06-01T00:00:00Z')), '13F Dec 31');
});

test('exactly 5% is not above the threshold', () => {
  const view = buildOwnershipView({
    reported: true,
    institutional_shares: 500,
    as_of: '2026-06-30',
    positions: [
      { name: 'Edge', shares: 500, as_of: '2026-06-30', source: 'Form 13F', group: 'owners' },
      { name: 'Next', shares: 100, as_of: '2026-06-30', source: 'Form 13F', group: 'owners' },
    ],
    beneficial: [],
    notes: [],
  }, 10000);
  assert.equal(view.holders[0].above, false);
  assert.equal(view.fallback_top, true);
});

test('a newer 13F replaces an older 13G with the same name, and a fresher 13G replaces the 13F', () => {
  const older = buildOwnershipView({
    reported: true,
    institutional_shares: 1000,
    as_of: '2026-06-30',
    positions: [{ name: 'Blackrock, Inc.', shares: 100, as_of: '2026-06-30', source: 'Form 13F', group: 'owners' }],
    beneficial: [{ name: 'BlackRock, Inc.', shares: 900, as_of: '2024-11-08', source: 'SC 13G/A', group: 'owners' }],
    notes: [],
  }, 10000);
  assert.equal(older.holders.find((h) => /blackrock/i.test(h.name)).shares, 100);
  assert.equal(older.holders.find((h) => /blackrock/i.test(h.name)).source, 'Form 13F');

  const newer = buildOwnershipView({
    reported: true,
    institutional_shares: 1000,
    as_of: '2026-06-30',
    positions: [{ name: 'Blackrock, Inc.', shares: 100, as_of: '2026-06-30', source: 'Form 13F', group: 'owners' }],
    beneficial: [{ name: 'BlackRock, Inc.', shares: 900, as_of: '2026-10-01', source: 'SC 13D/A', group: 'owners' }],
    notes: [],
  }, 10000);
  const row = newer.holders.find((h) => /blackrock/i.test(h.name));
  assert.equal(row.shares, 900);
  assert.equal(row.source, 'SC 13D/A');
});

test('Vanguard entities are not combined', () => {
  const positions = [
    { name: 'Vanguard Group Inc', shares: 24062886, as_of: '2025-12-31' },
    { name: 'Vanguard Portfolio Management Llc', shares: 15353408, as_of: '2026-06-30' },
  ];
  const notes = familyNotes(positions, [{ name: 'Vanguard Group Inc' }], BASIC);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /were not combined/);
  assert.match(notes[0], /Vanguard Group Inc/);
  assert.match(notes[0], /Vanguard Portfolio Management Llc/);
  assert.equal(normalizeHolderName('Vanguard Group Inc'), normalizeHolderName('VANGUARD GROUP INC'));
  assert.notEqual(normalizeHolderName('Vanguard Group Inc'), normalizeHolderName('Vanguard Portfolio Management Llc'));
});

test('Schedule 13G HTML keeps Saylor shares and drops a pre-merger holding', () => {
  const saylor = `
    NAMES OF REPORTING PERSONS. I.R.S. IDENTIFICATION NOS. OF ABOVE PERSONS (ENTITIES ONLY). Michael J. Saylor 2 CHECK THE APPROPRIATE BOX
    AGGREGATE AMOUNT BENEFICIALLY OWNED BY EACH REPORTING PERSON 19,998,580 shares
    PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (9) 9.9%
    Date of Event Which Requires Filing of this Statement September 30, 2024
    Item 5. Ownership of Five Percent or Less of a Class: Not applicable Item 6. Ownership
  `;
  const parsed = parse13DGDocument(saylor, { basicShares: BASIC, filingDate: '2024-10-25', form: 'SC 13G/A', filerName: 'SAYLOR MICHAEL J' });
  assert.equal(parsed.name, 'Michael J. Saylor');
  assert.equal(parsed.shares, 19998580);
  assert.equal(parsed.as_of, '2024-09-30');
  assert.equal(filingMatchesShareBase(19998580, 9.9, BASIC), true);

  const edgarOrder = `
    (CUSIP Number) September 30, 2024 (Date of Event Which Requires Filing of this Statement)
    (ENTITIES ONLY). Michael J. Saylor 2 CHECK THE APPROPRIATE BOX
    AGGREGATE AMOUNT BENEFICIALLY OWNED BY EACH REPORTING PERSON 19,998,580 shares
    PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (9) 9.9%
  `;
  assert.equal(parse13DGDocument(edgarOrder, { basicShares: BASIC, filingDate: '2024-10-25', form: 'SC 13G/A' }).as_of, '2024-09-30');

  const plaintext = `
    September 30, 2024
    --------------------------------------------------------
    (Date of Event Which Requires Filing of this Statement)
    (1)Names of reporting persons. BlackRock, Inc.
    (2) Check the appropriate box if a member of a group
    (9) Aggregate amount beneficially owned by each reporting person 9477813
    (11) Percent of class represented by amount in Row 9 5.2%
  `;
  const blackrock = parse13DGDocument(plaintext, { basicShares: BASIC, filingDate: '2024-11-08', form: 'SC 13G/A', filerName: 'BlackRock, Inc.' });
  assert.equal(blackrock.name, 'BlackRock, Inc');
  assert.equal(blackrock.shares, 9477813);
  assert.equal(blackrock.percent_reported, 5.2);
  assert.equal(blackrock.as_of, '2024-09-30');

  const preMerger = `
    NAMES OF REPORTING PERSONS Asset Entities Holdings, LLC 2 CHECK THE APPROPRIATE
    AGGREGATE AMOUNT BENEFICIALLY OWNED BY EACH REPORTING PERSON 1,250,000
    PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (9) 36.2%
    Item 5. Ownership of 5 Percent or Less of a Class. ceased to be the beneficial owner of more than 5 percent of the class of securities, check the following. * With respect to Derek Dunlop only. Item 6. Other
  `;
  assert.equal(parse13DGDocument(preMerger, { basicShares: 127328346, filingDate: '2024-10-03', form: 'SC 13G/A' }), null);
  assert.equal(filingMatchesShareBase(1250000, 36.2, 127328346), false);
});

test('a joint 13G keeps the EDGAR filer and does not add the other names', () => {
  const text = `
    (1) Names of Reporting Persons Capital Ventures International (2) Check the Appropriate
    AGGREGATE AMOUNT BENEFICIALLY OWNED BY EACH REPORTING PERSON 8,373,599
    PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (9) 4.6%
    (1) Names of Reporting Persons Susquehanna Securities, LLC (2) Check the Appropriate
    AGGREGATE AMOUNT BENEFICIALLY OWNED BY EACH REPORTING PERSON 8,373,599
    PERCENT OF CLASS REPRESENTED BY AMOUNT IN ROW (9) 4.6%
    Date of Event Which Requires Filing of this Statement November 14, 2024
  `;
  const parsed = parse13DGDocument(text, {
    basicShares: BASIC, filingDate: '2024-11-14', form: 'SC 13G/A', filerName: 'SUSQUEHANNA SECURITIES, LLC',
  });
  assert.equal(parsed.name, 'Susquehanna Securities, LLC');
  assert.equal(parsed.shares, 8373599);
  assert.deepEqual(parsed.joint_names, ['Capital Ventures International']);

  const view = buildOwnershipView({
    reported: true,
    institutional_shares: 1000,
    as_of: '2026-06-30',
    positions: [],
    beneficial: [{ ...parsed, group: 'owners' }],
    notes: [],
  }, 100000000);
  assert.equal(view.holders[0].name, 'Susquehanna Securities, LLC');
  assert.match(view.notes.at(-1), /were not added together/);
  assert.match(view.notes.at(-1), /Capital Ventures International/);
});

test('filing index prefers the schedule over an exhibit and a complete submission', () => {
  const names = [
    '0001193125-24-244223-index-headers.html',
    '0001193125-24-244223-index.html',
    '0001193125-24-244223.txt',
    'd886741dex991.htm',
    'd886741dsc13ga.htm',
  ];
  assert.equal(pickFilingDocument(names, '0001193125-24-244223'), 'd886741dsc13ga.htm');
  const textOnly = [
    '0002012383-24-004177-index.html',
    '0002012383-24-004177.txt',
    'us5949724083_110824.txt',
  ];
  assert.equal(pickFilingDocument(textOnly, '0002012383-24-004177'), 'us5949724083_110824.txt');
  assert.equal(pickFilingDocument(['primary.xml', 'pretty.htm'], '0000000000-00-000000'), 'primary.xml');
});

test('a 13G exit in XML is not a current holder', () => {
  const xml = `<?xml version="1.0"?><edgarSubmission><formData>
    <reportingPersonName>Example Fund</reportingPersonName>
    <aggregateAmountOwned>8000000</aggregateAmountOwned>
    <percentOfClass>6.2</percentOfClass>
    <dateOfEvent>06/01/2026</dateOfEvent>
    <item5><is5PercentOrLess>Y</is5PercentOrLess></item5>
  </formData></edgarSubmission>`;
  assert.equal(parse13DGDocument(xml, { basicShares: 100000000, filingDate: '2026-06-02', form: 'SC 13G/A' }), null);
});

test('major shareholder notice uses the after-change share count', () => {
  const text = `
    Notice Regarding Changes in Major Shareholders
    Corporate Name                    Capital Research and Management Company
    Location                          333 South Hope Street
    After the Change
    (as of October
    16, 2026)                          143,301,084 shares                      143,301,084 shares
    Notes:
    Large Shareholding Report (Change Report No. 31) filed on October 23, 2026.
    As the Change Report includes 5,902,500 non-voting Class B Preferred Shares.
  `;
  const parsed = parseMajorShareholderNotice(text);
  assert.equal(parsed.name, 'Capital Research and Management Company');
  assert.equal(parsed.shares, 143301084);
  assert.equal(parsed.as_of, '2026-10-16');
  assert.equal(parsed.preferred_excluded, 5902500);
  assert.equal(parsed.report, 'Change Report No. 31');
  assert.equal(parsed.ceased, false);
});

test('register rows and unconfirmed Evo footnote', () => {
  const tsv = [
    'level\tpage_num\tpar_num\tblock_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t0\t0\t0\t0\t43\t52\t10\t8\t100\t所有株式数別',
    '5\t1\t0\t0\t0\t0\t448\t66\t10\t8\t100\t2026年６月30日現在',
    '5\t1\t0\t0\t0\t0\t48\t147\t10\t8\t100\tCLEARSTREAM',
    '5\t1\t0\t0\t0\t1\t102\t147\t10\t8\t100\tBANKING',
    '5\t1\t0\t0\t0\t2\t140\t147\t10\t8\t100\tS.A.（常任代',
    '5\t1\t0\t0\t0\t0\t398\t154\t10\t8\t100\t123,787,665',
    '5\t1\t0\t0\t0\t1\t470\t154\t10\t8\t100\t9.49',
    '5\t1\t0\t0\t0\t0\t48\t609\t10\t8\t100\t計',
  ].join('\n');
  const parsed = parseRegisterHolders(tsv);
  assert.equal(parsed.as_of, '2026-06-30');
  assert.equal(parsed.holders.length, 1);
  assert.equal(parsed.holders[0].name, 'CLEARSTREAM BANKING S.A.');
  assert.equal(parsed.holders[0].shares, 123787665);
  assert.equal(parsed.holders[0].group, 'register');

  const note = parseUnconfirmedNotes('エボ　ファンド（Evo Fund）及びその共同保有者が2026年５月８日現在で次のとおり 334,732,550');
  assert.equal(note.length, 1);
  assert.match(note[0], /334,732,550/);
  assert.match(note[0], /2026-05-08/);
  assert.match(note[0], /not listed/);
});

test('a Japan large-holder floor is the cell percent and keeps holders above 5%', () => {
  const view = buildOwnershipView({
    reported: false,
    ok: true,
    reason: 'Japan has no Form 13F.',
    positions: [],
    beneficial: [{ name: 'Capital Research and Management Company', shares: 143301084, as_of: '2026-10-16', source: 'Major shareholder notice 2026-10-23', group: 'owners' }],
    register: [{ name: 'CLEARSTREAM BANKING S.A.', shares: 123787665, as_of: '2026-06-30', source: 'Shareholder register', group: 'register' }],
    notes: [],
    floor: {
      pct: 11.11326,
      label: '≥5% institutional filers (Japan large-holding reports)',
      as_of: '2026-10-16',
      shares: 143301084,
      voting_rights: 1433010,
      voting_rights_total: 12894494,
      holder: 'Capital Research and Management Company',
      report: 'Change Report No. 31',
    },
    estimate: { as_of: '2025-12-31', pct: 44.6, raw_pct: 69.3 },
    insiders: { text: 'Insiders: MMXX Ventures plus Simon Gerovich own about 9.5–10.9%.' },
  }, 1290274296);
  assert.equal(view.floor, true);
  assert.equal(view.reported, true);
  assert.equal(view.pct.toFixed(1), '11.1');
  assert.equal(view.as_of_label, '≥5% institutional filers (Japan large-holding reports)');
  assert.match(view.floor_detail, /1,433,010 voting rights/);
  assert.equal(view.holders.length, 2);
  assert.match(view.notes.join('\n'), /~44\.6%/);
  assert.match(view.notes.join('\n'), /69\.3%/);
  assert.match(view.notes.join('\n'), /9\.5–10\.9%/);
});

test('Metaplanet view is not reported and still lists holders above 5%', () => {
  const view = buildOwnershipView({
    reported: false,
    ok: true,
    reason: 'Japan has no Form 13F. Metaplanet does not publish a total of shares held by institutions, so this percentage is not reported.',
    positions: [],
    beneficial: [{ name: 'Capital Research and Management Company', shares: 143301084, as_of: '2026-10-16', source: 'Major shareholder notice 2026-10-23', group: 'owners' }],
    register: [
      { name: 'CLEARSTREAM BANKING S.A.', shares: 123787665, as_of: '2026-06-30', source: 'Shareholder register', group: 'register' },
      { name: 'CHARLES SCHWAB FBO CUSTOMER', shares: 56319052, as_of: '2026-06-30', source: 'Shareholder register', group: 'register' },
    ],
    notes: ['Evo note'],
  }, 1364255696, new Date('2026-10-27T00:00:00Z'));
  assert.equal(view.reported, false);
  assert.match(view.reason, /no Form 13F/);
  assert.equal(view.fallback_top, false);
  assert.deepEqual(view.holders.map((h) => h.name), [
    'Capital Research and Management Company',
    'CLEARSTREAM BANKING S.A.',
  ]);
  assert.ok(view.holders[0].pct > 5);
  assert.ok(view.holders[1].pct > 5);
});

test('a failed refresh keeps the saved total and does not retry inside 20 hours', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.equal(shouldRefreshOwnership({ attempted_at: '2026-10-27T00:00:00Z' }, now), false);
  assert.equal(shouldRefreshOwnership({ attempted_at: '2026-10-26T10:00:00Z' }, now), true);
  assert.equal(shouldRefreshOwnership(null, now), true);
  const view = buildOwnershipView({
    reported: true,
    ok: true,
    institutional_shares: 234146230,
    holders_count: 1078,
    as_of: '2026-06-30',
    fetched_at: '2026-10-26T12:00:00Z',
    last_error: 'Nasdaq HTTP 403',
    positions: [],
    beneficial: [],
    notes: [],
  }, BASIC, new Date('2026-10-27T00:00:00Z'));
  assert.equal(view.institutional_shares, 234146230);
  assert.match(view.notes[0], /Nasdaq HTTP 403/);
  assert.match(view.notes[0], /2026-10-26/);
});
