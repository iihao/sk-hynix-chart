# Open Interest Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `openInterest` factor use real Binance OI changes in both live scoring and backtests, while keeping `takerVol` as a separate factor.

**Architecture:** Add a reusable OI scoring helper in `lib/factor-support.js`, cover it with focused unit tests, and call the same helper from the live factor path and the backtest scoring path in `server.js`. Live scoring will load a short recent sentiment window so it can compare the latest row against a real OI baseline instead of proxying through taker flow.

**Tech Stack:** Node.js, CommonJS, Express, better-sqlite3, node:test

---

## File Structure

- Modify: `lib/factor-support.js:1-207`
  Add a shared `scoreOpenInterestSignal` helper plus small internal helpers for metric selection and baseline lookup.
- Modify: `test/factor-support.test.js:1-112`
  Add focused tests for bullish confirmation, bearish confirmation, OI decline, and insufficient-history fallback.
- Modify: `server.js:5-11`
  Import the new helper.
- Modify: `server.js:1314-1342`
  Refactor `factorOpenInterest` to consume recent sentiment rows and render detail text from the helper output.
- Modify: `server.js:1690-1705`
  Load a recent sentiment window for live factor generation and pass that window into `factorOpenInterest`.
- Modify: `server.js:1941-1970`
  Replace the backtest OI proxy logic with the shared helper.

## Workspace Note

This output directory is not a git repository, so the usual per-task commit step becomes a changed-file checkpoint. Do not add git commands during execution unless the workspace is later moved into a real repository.

### Task 1: Add and Prove the Shared OI Scoring Helper

**Files:**
- Modify: `test/factor-support.test.js`
- Modify: `lib/factor-support.js`

- [ ] **Step 1: Write the failing helper tests**

```js
const {
  normalizeTimeframe,
  parseGoogleNewsRss,
  mergeSentimentHistory,
  buildFactorCoverage,
  scoreOpenInterestSignal,
} = require('../lib/factor-support');

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
```

- [ ] **Step 2: Run the targeted test file and confirm the helper is missing**

Run: `npm test -- --test-name-pattern="scoreOpenInterestSignal"`

Expected: FAIL with a message equivalent to `scoreOpenInterestSignal is not a function` or an assertion failure caused by the missing export.

- [ ] **Step 3: Implement the shared helper and export it**

```js
function getOpenInterestMetric(row) {
  const oiValue = Number(row?.oi_value) || 0;
  if (oiValue > 0) return { metric: 'oi_value', value: oiValue };
  const contracts = Number(row?.open_interest) || 0;
  if (contracts > 0) return { metric: 'open_interest', value: contracts };
  return null;
}

function scoreOpenInterestSignal({ sentimentRows = [], priceNow, pricePrev, maxLookback = 3 }) {
  if (!Array.isArray(sentimentRows) || sentimentRows.length < 2) {
    return {
      score: 0,
      weight: 0,
      metric: null,
      direction: 'neutral',
      latestValue: 0,
      baselineValue: 0,
      oiChangePct: 0,
      priceChangePct: 0,
      reason: 'insufficient-history',
    };
  }
  if (!Number.isFinite(priceNow) || !Number.isFinite(pricePrev) || pricePrev === 0) {
    return {
      score: 0,
      weight: 0,
      metric: null,
      direction: 'neutral',
      latestValue: 0,
      baselineValue: 0,
      oiChangePct: 0,
      priceChangePct: 0,
      reason: 'insufficient-price-history',
    };
  }

  const latestMetric = getOpenInterestMetric(sentimentRows[sentimentRows.length - 1]);
  if (!latestMetric) {
    return {
      score: 0,
      weight: 0,
      metric: null,
      direction: 'neutral',
      latestValue: 0,
      baselineValue: 0,
      oiChangePct: 0,
      priceChangePct: 0,
      reason: 'missing-open-interest',
    };
  }

  let baselineMetric = null;
  for (let offset = 2; offset <= Math.min(sentimentRows.length, maxLookback + 1); offset++) {
    const candidate = getOpenInterestMetric(sentimentRows[sentimentRows.length - offset]);
    if (candidate && candidate.metric === latestMetric.metric && candidate.value > 0) {
      baselineMetric = candidate;
      break;
    }
  }

  if (!baselineMetric) {
    return {
      score: 0,
      weight: 0,
      metric: latestMetric.metric,
      direction: 'neutral',
      latestValue: latestMetric.value,
      baselineValue: 0,
      oiChangePct: 0,
      priceChangePct: 0,
      reason: 'insufficient-history',
    };
  }

  const oiChangePct = (latestMetric.value - baselineMetric.value) / baselineMetric.value;
  const priceChangePct = (priceNow - pricePrev) / pricePrev;
  const absOiChange = Math.abs(oiChangePct);
  const absPriceChange = Math.abs(priceChangePct);

  let score = 0;
  let direction = 'neutral';
  if (absOiChange >= 0.003 && absPriceChange >= 0.002) {
    if (oiChangePct > 0 && priceChangePct > 0) {
      score = 3;
      direction = 'bullish';
    } else if (oiChangePct > 0 && priceChangePct < 0) {
      score = -3;
      direction = 'bearish';
    } else if (oiChangePct < 0 && priceChangePct > 0) {
      score = 1;
      direction = 'short-covering';
    } else if (oiChangePct < 0 && priceChangePct < 0) {
      score = -1;
      direction = 'long-unwind';
    }
  }

  return {
    score,
    weight: 0.55,
    metric: latestMetric.metric,
    direction,
    latestValue: latestMetric.value,
    baselineValue: baselineMetric.value,
    oiChangePct,
    priceChangePct,
    reason: 'ok',
  };
}

module.exports = {
  buildFactorCoverage,
  decodeHtmlEntities,
  extractRssItems,
  getTimeframeConfig,
  mergeSentimentHistory,
  normalizeTimeframe,
  parseGoogleNewsRss,
  parsePubDate,
  scoreOpenInterestSignal,
};
```

- [ ] **Step 4: Re-run the targeted helper tests**

Run: `npm test -- --test-name-pattern="scoreOpenInterestSignal"`

Expected: PASS for all four new helper tests.

- [ ] **Step 5: Checkpoint the changed files**

Run: `ls /Users/huangqiang/.qoderworkcn/workspace/mr3k2shx46vyj9eq/outputs/sk-hynix-chart/lib/factor-support.js /Users/huangqiang/.qoderworkcn/workspace/mr3k2shx46vyj9eq/outputs/sk-hynix-chart/test/factor-support.test.js`

Expected: Both file paths print successfully.

### Task 2: Use the Shared Helper in the Live Factor Path

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Update the import and the live sentiment lookup**

```js
const {
  buildFactorCoverage,
  getTimeframeConfig,
  mergeSentimentHistory,
  normalizeTimeframe,
  parseGoogleNewsRss,
  scoreOpenInterestSignal,
} = require('./lib/factor-support');

const sentimentNow = Math.floor(Date.now() / 1000);
const sentimentRows = selectSentimentRange.all(sentimentNow - 6 * 3600, sentimentNow);
const sentimentLatest = sentimentRows[sentimentRows.length - 1] || selectSentimentLatest.get();
```

- [ ] **Step 2: Run the full test suite as a baseline before touching `server.js`**

Run: `npm test`

Expected: PASS. The new helper should not break the existing suite before the live-path refactor starts.

- [ ] **Step 3: Refactor `factorOpenInterest` and pass the sentiment window into it**

```js
function factorOpenInterest(sentimentRows, candles) {
  const rows = Array.isArray(sentimentRows) ? sentimentRows : (sentimentRows ? [sentimentRows] : []);
  const latest = rows[rows.length - 1];
  if (!latest || !candles || candles.length < 5) {
    return { score: 0, weight: 0, detail: '数据不足' };
  }

  const priceNow = candles[candles.length - 1].close;
  const pricePrev = candles[Math.max(0, candles.length - 5)].close;
  const signal = scoreOpenInterestSignal({ sentimentRows: rows, priceNow, pricePrev });
  if (!signal.weight) {
    return { score: 0, weight: 0, detail: '数据不足' };
  }

  const oiArrow = signal.oiChangePct > 0 ? '↑' : signal.oiChangePct < 0 ? '↓' : '→';
  const priceArrow = signal.priceChangePct > 0 ? '↑' : signal.priceChangePct < 0 ? '↓' : '→';
  const latestOiText = signal.metric === 'oi_value'
    ? `$${(signal.latestValue / 1000000).toFixed(1)}M`
    : `${(signal.latestValue / 1000).toFixed(1)}K`;

  return {
    category: 'openInterest',
    label: '持仓量',
    score: Math.round(signal.score * 10) / 10,
    weight: signal.weight,
    detail: `OI ${latestOiText} ${oiArrow}${Math.abs(signal.oiChangePct * 100).toFixed(1)}% | 价格${priceArrow}${Math.abs(signal.priceChangePct * 100).toFixed(1)}%`,
  };
}

const factors = [
  factorMomentum(candles),
  factorFundingRate(binanceTicks),
  factorVolume(candles),
  factorVolatility(candles),
  factorExchangeRate(),
  factorPremium(naverLatest, binanceLatest),
  factorIndicatorMomentum(indicators),
  factorSupportResistance(candles, sr),
  factorLongShortRatio(sentimentLatest),
  factorTakerVolume(sentimentLatest),
  factorOpenInterest(sentimentRows.length ? sentimentRows : sentimentLatest ? [sentimentLatest] : [], candles),
  factorLongShortTrend(),
  factorWhaleActivity(),
  factorNewsSentiment(),
].filter(f => f.weight > 0);
```

- [ ] **Step 4: Re-run the full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Checkpoint the changed server file**

Run: `ls /Users/huangqiang/.qoderworkcn/workspace/mr3k2shx46vyj9eq/outputs/sk-hynix-chart/server.js`

Expected: The file path prints successfully.

### Task 3: Reuse the Helper in Backtests and Run End-to-End Verification

**Files:**
- Modify: `server.js`
- Test: `test/factor-support.test.js`

- [ ] **Step 1: Replace the backtest OI proxy with the shared helper**

```js
// Open Interest + Price
const pricePrev = idx >= 5 ? closes[idx - 5] : null;
const oiSignal = scoreOpenInterestSignal({
  sentimentRows: sentimentWindow,
  priceNow: last,
  pricePrev,
});
openInterest = oiSignal.score;
```

- [ ] **Step 2: Run syntax validation and automated tests**

Run: `node --check server.js && npm test`

Expected: No syntax errors, then PASS for the full test suite.

- [ ] **Step 3: Run a local runtime check on a temporary port**

Run:

```bash
PORT=3461 node server.js >/tmp/sk-hynix-oi.log 2>&1 &
SERVER_PID=$!
sleep 3
node -e 'fetch("http://127.0.0.1:3461/api/factors?tf=m15").then(r => r.json()).then(data => { const f = data.factors.find(x => x.category === "openInterest"); if (!f) throw new Error("openInterest missing"); console.log(JSON.stringify(f)); }).catch(err => { console.error(err); process.exit(1); })'
kill $SERVER_PID
wait $SERVER_PID 2>/dev/null || true
```

Expected: Printed JSON for the `openInterest` factor that still includes `category`, `score`, `weight`, and `detail`, with `detail` mentioning both OI and price direction.

- [ ] **Step 4: Spot-check that coverage still stays intact**

Run:

```bash
PORT=3462 node server.js >/tmp/sk-hynix-oi-coverage.log 2>&1 &
SERVER_PID=$!
sleep 3
node -e 'fetch("http://127.0.0.1:3462/api/factors?tf=m15").then(r => r.json()).then(data => { console.log(JSON.stringify(data.coverage)); }).catch(err => { console.error(err); process.exit(1); })'
kill $SERVER_PID
wait $SERVER_PID 2>/dev/null || true
```

Expected: Coverage JSON prints successfully, and `activeCategories` includes `openInterest` while `missingCategories` does not.

- [ ] **Step 5: Final changed-file checkpoint**

Run: `ls /Users/huangqiang/.qoderworkcn/workspace/mr3k2shx46vyj9eq/outputs/sk-hynix-chart/server.js /Users/huangqiang/.qoderworkcn/workspace/mr3k2shx46vyj9eq/outputs/sk-hynix-chart/lib/factor-support.js /Users/huangqiang/.qoderworkcn/workspace/mr3k2shx46vyj9eq/outputs/sk-hynix-chart/test/factor-support.test.js`

Expected: All three file paths print successfully.
