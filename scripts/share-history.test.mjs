import test from 'node:test';
import assert from 'node:assert/strict';
import { applyShareSnapshot, describeShareChange } from './update.mjs';

test('change is the latest basic count minus the prior as_of', () => {
  const history = { companies: {} };
  assert.equal(applyShareSnapshot(history, { id: 'strategy', asOf: '2026-10-11', basicShares: 422118949 }), true);
  assert.equal(applyShareSnapshot(history, { id: 'strategy', asOf: '2026-10-18', basicShares: 422259821 }), true);
  assert.equal(history.companies.strategy.length, 2);
  const change = describeShareChange(history.companies.strategy, '2026-10-18', 422259821);
  assert.deepEqual(change, {
    as_of: '2026-10-18',
    basic_shares: 422259821,
    previous_as_of: '2026-10-11',
    previous_basic_shares: 422118949,
    delta: 140872,
    direction: 'up',
  });
});

test('the same as_of and count is not appended again', () => {
  const history = { companies: { strategy: [{ as_of: '2026-10-11', basic_shares: 422118949, source: 'seed' }] } };
  assert.equal(applyShareSnapshot(history, {
    id: 'strategy',
    asOf: '2026-10-11',
    basicShares: 422118949,
    source: 'a later run',
  }), false);
  assert.equal(history.companies.strategy.length, 1);
  assert.equal(history.companies.strategy[0].source, 'seed');
  assert.equal(history.companies.strategy[0].recorded_at, undefined);
});

test('a revised count on the same as_of replaces that row', () => {
  const history = { companies: { strive: [{ as_of: '2026-10-20', basic_shares: 1 }] } };
  assert.equal(applyShareSnapshot(history, { id: 'strive', asOf: '2026-10-20', basicShares: 124064126 }), true);
  assert.equal(history.companies.strive.length, 1);
  assert.equal(history.companies.strive[0].basic_shares, 124064126);
  assert.equal(typeof history.companies.strive[0].recorded_at, 'string');
});

test('unchanged when the new as_of carries the same count', () => {
  const entries = [
    { as_of: '2026-10-09', basic_shares: 110387204 },
    { as_of: '2026-10-20', basic_shares: 110387204 },
  ];
  const change = describeShareChange(entries, '2026-10-20', 110387204);
  assert.equal(change.direction, 'unchanged');
  assert.equal(change.delta, 0);
  assert.equal(change.previous_as_of, '2026-10-09');
});

test('a decrease is the shares removed', () => {
  const change = describeShareChange(
    [{ as_of: '2026-08-31', basic_shares: 1000 }, { as_of: '2026-09-30', basic_shares: 219 }],
    '2026-09-30',
    219,
  );
  assert.equal(change.direction, 'down');
  assert.equal(change.delta, -781);
  assert.equal(change.previous_basic_shares, 1000);
});

test('no prior count yet when the snapshot is the only row', () => {
  const change = describeShareChange([{ as_of: '2026-09-30', basic_shares: 1364255696 }], '2026-09-30', 1364255696);
  assert.equal(change.direction, 'none');
  assert.equal(change.previous_as_of, null);
  assert.equal(change.delta, null);
});

test('an earlier as_of is inserted in date order and does not duplicate', () => {
  const history = { companies: { metaplanet: [{ as_of: '2026-09-30', basic_shares: 1364255696 }] } };
  assert.equal(applyShareSnapshot(history, { id: 'metaplanet', asOf: '2026-08-31', basicShares: 1345313741 }), true);
  assert.deepEqual(history.companies.metaplanet.map((e) => e.as_of), ['2026-08-31', '2026-09-30']);
  const change = describeShareChange(history.companies.metaplanet, '2026-09-30', 1364255696);
  assert.equal(change.delta, 1364255696 - 1345313741);
  assert.equal(change.direction, 'up');
  assert.equal(change.previous_as_of, '2026-08-31');
});

test('missing count or date is not stored', () => {
  const history = { companies: {} };
  assert.equal(applyShareSnapshot(history, { id: 'strategy', asOf: '2026-10-18', basicShares: null }), false);
  assert.equal(applyShareSnapshot(history, { id: 'strategy', asOf: '', basicShares: 1 }), false);
  assert.equal(applyShareSnapshot(history, { id: 'strategy', asOf: '2026-10-18', basicShares: 1.5 }), false);
  assert.deepEqual(history.companies, {});
  assert.equal(describeShareChange([], null, null).direction, 'none');
});
