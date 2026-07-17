const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTimeframe,
  parseGoogleNewsRss,
  mergeSentimentHistory,
  buildFactorCoverage,
  scoreOpenInterestSignal,
} = require('../lib/factor-support');

test('parseGoogleNewsRss extracts item titles and scores keywords', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <rss>
    <channel>
      <title>Feed</title>
      <item>
        <title>SK hynix HBM supply deal expands AI server demand</title>
        <pubDate>Thu, 16 Jul 2026 08:00:00 GMT</pubDate>
      </item>
      <item>
        <title>SK hynix faces inventory risk and price decline</title>
        <pubDate>Wed, 15 Jul 2026 08:00:00 GMT</pubDate>
      </item>
      <item>
        <title>HBM capacity reaches new high</title>
        <pubDate>Fri, 12 Jun 2026 08:00:00 GMT</pubDate>
      </item>
    </channel>
  </rss>`;

  const result = parseGoogleNewsRss(
    xml,
    ['HBM', 'AI', 'deal'],
    ['risk', 'decline'],
    { nowMs: Date.parse('2026-07-16T12:00:00Z'), maxAgeHours: 24 * 7 }
  );

  assert.equal(result.headlines.length, 2);
  assert.equal(result.positive, 3);
  assert.equal(result.negative, 2);
  assert.equal(result.score, 1);
  assert.equal(result.headlines[0], 'SK hynix HBM supply deal expands AI server demand');
  assert.equal(result.latestPublishedAt, Date.parse('2026-07-16T08:00:00Z'));
});

test('mergeSentimentHistory aligns Binance sentiment by source timestamps', () => {
  const base = 1784102400000;
  const rows = mergeSentimentHistory({
    lsData: [
      { timestamp: base, longShortRatio: '1.50', longAccount: '0.60', shortAccount: '0.40' },
      { timestamp: base + 3600000, longShortRatio: '1.80', longAccount: '0.64', shortAccount: '0.36' },
    ],
    takerData: [
      { timestamp: base, buySellRatio: '1.05', buyVol: '1000', sellVol: '950' },
    ],
    oiData: [
      { timestamp: base, sumOpenInterest: '210000', sumOpenInterestValue: '260000000' },
      { timestamp: base + 3600000, sumOpenInterest: '220000', sumOpenInterestValue: '270000000' },
    ],
    topData: [
      { timestamp: base, longShortRatio: '2.10', longAccount: '0.68', shortAccount: '0.32' },
      { timestamp: base + 3600000, longShortRatio: '1.95', longAccount: '0.66', shortAccount: '0.34' },
    ],
  });

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    ts: Math.floor(base / 1000),
    ls_ratio: 1.5,
    ls_long_pct: 0.6,
    ls_short_pct: 0.4,
    taker_ratio: 1.05,
    taker_buy_vol: 1000,
    taker_sell_vol: 950,
    open_interest: 210000,
    oi_value: 260000000,
    top_ls_ratio: 2.1,
    top_long_pct: 0.68,
    top_short_pct: 0.32,
  });
  assert.deepEqual(rows[1], {
    ts: Math.floor((base + 3600000) / 1000),
    ls_ratio: 1.8,
    ls_long_pct: 0.64,
    ls_short_pct: 0.36,
    taker_ratio: 1.05,
    taker_buy_vol: 1000,
    taker_sell_vol: 950,
    open_interest: 220000,
    oi_value: 270000000,
    top_ls_ratio: 1.95,
    top_long_pct: 0.66,
    top_short_pct: 0.34,
  });
});

test('buildFactorCoverage reports missing factors and healthy sources', () => {
  const coverage = buildFactorCoverage({
    expectedFactors: [
      { category: 'momentum', label: '价格动量' },
      { category: 'news', label: '新闻情绪' },
      { category: 'whale', label: '庄家动向' },
    ],
    factors: [
      { category: 'momentum', label: '价格动量', score: 2.5 },
      { category: 'whale', label: '庄家动向', score: 1.0 },
    ],
    sourceHealth: [
      { key: 'news', status: 'stale' },
      { key: 'naver', status: 'ok' },
      { key: 'sentiment', status: 'ok' },
    ],
  });

  assert.equal(coverage.expectedCount, 3);
  assert.equal(coverage.activeCount, 2);
  assert.equal(coverage.coveragePct, 66.7);
  assert.deepEqual(coverage.missingCategories, ['news']);
  assert.deepEqual(coverage.missingLabels, ['新闻情绪']);
  assert.equal(coverage.healthySources, 2);
  assert.equal(coverage.totalSources, 3);
});

test('normalizeTimeframe supports UI aliases and defaults safely', () => {
  assert.equal(normalizeTimeframe('m1'), '1m');
  assert.equal(normalizeTimeframe('m5'), '5m');
  assert.equal(normalizeTimeframe('m15'), '15m');
  assert.equal(normalizeTimeframe('h1'), '1h');
  assert.equal(normalizeTimeframe('15m'), '15m');
  assert.equal(normalizeTimeframe('weird'), '5m');
});

test('scoreOpenInterestSignal detects bullish OI confirmation', () => {
  const signal = scoreOpenInterestSignal({
    sentimentRows: [
      { ts: 1, oi_value: 260000000, open_interest: 210000 },
      { ts: 2, oi_value: 272000000, open_interest: 214000 },
    ],
    priceNow: 102,
    pricePrev: 100,
  });

  assert.equal(signal.score, 3);
  assert.equal(signal.weight, 0.55);
  assert.equal(signal.metric, 'oi_value');
  assert.equal(signal.direction, 'bullish');
});

test('scoreOpenInterestSignal detects bearish OI confirmation', () => {
  const signal = scoreOpenInterestSignal({
    sentimentRows: [
      { ts: 1, oi_value: 260000000, open_interest: 210000 },
      { ts: 2, oi_value: 274000000, open_interest: 214000 },
    ],
    priceNow: 97,
    pricePrev: 100,
  });

  assert.equal(signal.score, -3);
  assert.equal(signal.direction, 'bearish');
});

test('scoreOpenInterestSignal weakens moves when OI falls', () => {
  const signal = scoreOpenInterestSignal({
    sentimentRows: [
      { ts: 1, oi_value: 280000000, open_interest: 215000 },
      { ts: 2, oi_value: 270000000, open_interest: 209000 },
    ],
    priceNow: 102,
    pricePrev: 100,
  });

  assert.equal(signal.score, 1);
  assert.equal(signal.direction, 'short-covering');
});

test('scoreOpenInterestSignal falls back to neutral when history is missing', () => {
  const signal = scoreOpenInterestSignal({
    sentimentRows: [{ ts: 2, oi_value: 272000000, open_interest: 214000 }],
    priceNow: 102,
    pricePrev: 100,
  });

  assert.equal(signal.score, 0);
  assert.equal(signal.weight, 0);
  assert.equal(signal.reason, 'insufficient-history');
});
