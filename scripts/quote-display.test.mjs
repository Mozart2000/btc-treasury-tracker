import test from 'node:test';
import assert from 'node:assert/strict';
import { regularSessionClose } from './update.mjs';

const session = { start: 1_000, end: 2_000 };

test('after the regular session, the close is the regular-session price', () => {
  assert.equal(regularSessionClose({
    regularMarketPrice: 265,
    chartPreviousClose: 269,
    currentTradingPeriod: { regular: session },
  }, 2_000), 265);
});

test('before the regular session, the close is still the last regular price', () => {
  assert.equal(regularSessionClose({
    regularMarketPrice: 265,
    chartPreviousClose: 269,
    currentTradingPeriod: { regular: session },
  }, 999), 265);
});

test('during the session, the close is the previous session close', () => {
  assert.equal(regularSessionClose({
    regularMarketPrice: 270,
    previousClose: 265,
    chartPreviousClose: 264,
    currentTradingPeriod: { regular: session },
  }, 1_500), 265);
});

test('during the session, chartPreviousClose is used when previousClose is absent', () => {
  assert.equal(regularSessionClose({
    regularMarketPrice: 270,
    chartPreviousClose: 269,
    currentTradingPeriod: { regular: session },
  }, 1_500), 269);
});

test('during the session with no prior close, fall back to the regular price', () => {
  assert.equal(regularSessionClose({
    regularMarketPrice: 270,
    currentTradingPeriod: { regular: session },
  }, 1_500), 270);
});

test('a quote with no session metadata uses the regular price', () => {
  assert.equal(regularSessionClose({ regularMarketPrice: 265 }, 1_500), 265);
});

test('missing price returns null', () => {
  assert.equal(regularSessionClose({ chartPreviousClose: 1 }, 1_500), null);
});
