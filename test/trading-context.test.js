const test = require('node:test');
const assert = require('node:assert/strict');

const {
  alignBasisSeries,
  buildRiskOverlay,
  computeBasisSnapshot,
  deriveRegime,
  getEventWindow,
  getFundingCountdown,
  getKoreaSessionState,
} = require('../lib/trading-context');

test('getKoreaSessionState identifies regular session in KST', () => {
  const state = getKoreaSessionState(Date.parse('2026-07-16T01:30:00Z'));
  assert.equal(state.state, 'regular');
  assert.equal(state.label, '韩股常规盘');
});

test('getEventWindow enters freeze window ahead of earnings', () => {
  const event = getEventWindow(Date.parse('2026-07-28T02:00:00Z'));
  assert.equal(event.status, 'freeze');
  assert.equal(event.blockNewPositions, true);
});

test('getFundingCountdown uses explicit next funding time when available', () => {
  const funding = getFundingCountdown({
    nowMs: Date.parse('2026-07-16T06:00:00Z'),
    nextFundingTimeMs: Date.parse('2026-07-16T08:00:00Z'),
  });
  assert.equal(funding.minutesLeft, 120);
  assert.equal(funding.label, '2h 00m');
});

test('alignBasisSeries and computeBasisSnapshot detect stretched basis', () => {
  const baseTs = 1_784_102_400;
  const spotTicks = [];
  const binanceTicks = [];
  for (let i = 0; i < 24; i++) {
    const ts = baseTs + i * 900;
    spotTicks.push({ ts, price: 1800000 });
    const fair = 1800000 / 1500;
    const premium = i === 23 ? 0.08 : 0.01;
    binanceTicks.push({ ts, price: fair * (1 + premium) });
  }

  const series = alignBasisSeries({ spotTicks, binanceTicks, fxRate: 1500, bucketSec: 900 });
  const basis = computeBasisSnapshot(series, { lookback: 24 });

  assert.equal(series.length, 24);
  assert.equal(basis.ready, true);
  assert.equal(basis.state, 'extreme');
  assert.ok(basis.zScore > 2);
});

test('buildRiskOverlay blocks trade in freeze window and on expensive funding', () => {
  const eventBlocked = buildRiskOverlay({
    direction: '做多',
    atrPct: 1.4,
    volatilityScore: -2,
    fundingRate: 0.0008,
    eventStatus: 'freeze',
    basisZScore: 0.4,
    regimeMode: 'event',
  });
  assert.equal(eventBlocked.blocked, true);
  assert.equal(eventBlocked.positionPct, 0);

  const fundingBlocked = buildRiskOverlay({
    direction: '做多',
    atrPct: 0.8,
    volatilityScore: 0,
    fundingRate: 0.004,
    eventStatus: 'clear',
    basisZScore: 0.2,
    regimeMode: 'trend',
  });
  assert.equal(fundingBlocked.blocked, true);
  assert.equal(fundingBlocked.positionPct, 0);
});

test('buildRiskOverlay stays flat when there is no directional signal', () => {
  const flat = buildRiskOverlay({
    direction: '观望',
    atrPct: 0.9,
    volatilityScore: 0,
    fundingRate: 0,
    eventStatus: 'clear',
    basisZScore: 0.1,
    regimeMode: 'range',
  });

  assert.equal(flat.blocked, false);
  assert.equal(flat.action, 'flat');
  assert.equal(flat.positionPct, 0);
});

test('deriveRegime prioritizes event mode over trend and falls back to range', () => {
  const eventRegime = deriveRegime({
    composite: 6,
    consensus: 0.8,
    eventStatus: 'watch',
    basisZScore: 0.2,
    atrPct: 1,
  });
  assert.equal(eventRegime.mode, 'event');

  const trendRegime = deriveRegime({
    composite: 5,
    consensus: 0.7,
    eventStatus: 'clear',
    basisZScore: 0.8,
    atrPct: 1.2,
  });
  assert.equal(trendRegime.mode, 'trend');

  const rangeRegime = deriveRegime({
    composite: 1.2,
    consensus: 0.2,
    eventStatus: 'clear',
    basisZScore: 0.6,
    atrPct: 0.9,
  });
  assert.equal(rangeRegime.mode, 'range');
});
