# Data Correctness Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live factors and backtests consume only session-valid, fresh, currency-safe, timeframe-consistent market observations.

**Architecture:** Extract pure market-quality, candle, level, and FX alignment functions under `src/domain`, then compose them from the existing Express process. Keep SQLite and HTTP compatibility while adding explicit quality metadata and timestamped FX. Update the native browser modules to carry the active timeframe and render only levels matching the visible instrument.

**Tech Stack:** TypeScript, Node.js tests, Express, better-sqlite3, browser ES modules, Lightweight Charts.

---

### Task 1: Session-valid spot ticks and honest candles

**Files:**
- Create: `src/domain/market-quality.ts`
- Create: `src/domain/market-quality.test.ts`
- Create: `src/domain/candles.ts`
- Create: `src/domain/candles.test.ts`
- Modify: `server.ts`

- [ ] **Step 1: Write failing session and candle tests**

```ts
assert.equal(canRecordSpotTick({ nowMs: monday1900Kst, marketOpen: false, hasFreshAfterHours: false }), false);
assert.equal(canRecordSpotTick({ nowMs: monday1700Kst, marketOpen: false, hasFreshAfterHours: true }), true);
assert.deepEqual(buildSpotCandles([{ ts: 60, price: 100 }], 60)[0], {
  time: 60, open: 100, high: 100, low: 100, close: 100, volume: 0, sampleCount: 1,
});
```

- [ ] **Step 2: Run RED**

Run: `npm run build:test && node --test dist-test/src/domain/market-quality.test.js dist-test/src/domain/candles.test.js`

Expected: module-not-found or missing-export failures.

- [ ] **Step 3: Implement pure rules**

Export:

```ts
export function getKoreaSession(nowMs: number): 'pre' | 'regular' | 'after' | 'closed';
export function canRecordSpotTick(input: { nowMs: number; marketOpen: boolean; hasFreshAfterHours: boolean }): boolean;
export function buildSpotCandles(ticks: SpotTick[], intervalSec: number): SpotCandle[];
```

Flat candles remain flat. `volume` is `0`; `sampleCount` records polling samples.

- [ ] **Step 4: Compose from server**

`recordTick` writes only when `canRecordSpotTick` returns true and never injects cached after-hours data before the write decision. Replace both server candle builders with the pure spot builder. Keep cached after-hours only in display snapshots.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test && npm run typecheck`

Commit: `fix: stop synthetic off-session spot ticks`

### Task 2: Currency-safe support and resistance

**Files:**
- Create: `src/domain/levels.ts`
- Create: `src/domain/levels.test.ts`
- Modify: `src/domain/indicators.ts`
- Modify: `server.ts`
- Modify: `public/js/dashboard-data.mjs`
- Modify: `public/js/chart.js`
- Modify: `test/dashboard-data.test.mjs`

- [ ] **Step 1: Write failing level tests**

```ts
const groups = buildLevelGroups({ spot: [{ price: 1800000 }], futures: [{ price: 1186 }] });
assert.equal(groups.spot.currency, 'KRW');
assert.equal(groups.futures.currency, 'USDT');
assert.equal(groups.spot.support[0].price, 1800000);
assert.equal(groups.futures.support[0].price, 1186);
```

- [ ] **Step 2: Run RED**

Run: `npm run build:test && node --test dist-test/src/domain/levels.test.js`

Expected: missing module failure.

- [ ] **Step 3: Return separate typed groups**

Export `buildLevelGroups` and change `/api/indicators` to return:

```ts
levels: {
  spot: { instrument: '000660', source: 'naver', currency: 'KRW', support, resistance },
  futures: { instrument: 'SKHYNIXUSDT', source: 'binance', currency: 'USDT', support, resistance },
}
```

Do not merge or deduplicate across groups.

- [ ] **Step 4: Render the visible group**

Normalize `levels` in `dashboard-data.mjs`. `updateSupportResistance` accepts one group, converts KRW with the snapshot FX rate, and leaves USDT unchanged. Naver charts select spot levels; Binance-specific overlays select futures levels.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test && npm run typecheck`

Commit: `fix: keep market levels currency safe`

### Task 3: Freshness-gated Binance factors

**Files:**
- Modify: `src/domain/market-quality.ts`
- Modify: `src/domain/market-quality.test.ts`
- Modify: `src/domain/factors.ts`
- Modify: `src/domain/factors.test.ts`
- Modify: `server.ts`
- Modify: `src/contracts/api.ts`

- [ ] **Step 1: Write failing freshness tests**

```ts
assert.equal(classifyObservationAge({ nowSec: 1000, exchangeTs: 850, maxAgeSec: 120 }).eligible, false);
const result = calculateAllFactors({ ...base, fundingRate: undefined, binancePrice: undefined });
assert.equal(result.factors.some(f => f.category === 'funding'), false);
assert.equal(result.omittedFactors.some(f => f.category === 'funding'), true);
```

- [ ] **Step 2: Run RED**

Run: `npm run build:test && node --test dist-test/src/domain/market-quality.test.js dist-test/src/domain/factors.test.js`

- [ ] **Step 3: Implement eligibility and omission**

Add `classifyObservationAge` and make cross-market factor inputs optional. `calculateAllFactors` omits unavailable factors and returns:

```ts
omittedFactors: Array<{ category: string; reason: 'missing' | 'stale' | 'unsupported' }>;
```

Sample-count volume is marked unsupported and omitted.

- [ ] **Step 4: Stop stale extension**

Remove flat-point generation from `getBinanceLocal`. Return `lastExchangeTs`, `ageSec`, and `quality`. In `/api/factors`, gate price/funding at 120 seconds and sentiment/OI at 7,200 seconds before passing them to the domain engine.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test && npm run typecheck`

Commit: `fix: exclude stale observations from factors`

### Task 4: Timeframe-consistent dashboard requests

**Files:**
- Modify: `public/js/dashboard-data.mjs`
- Modify: `test/dashboard-data.test.mjs`
- Modify: `public/js/app.js`
- Modify: `server.ts`

- [ ] **Step 1: Write failing query tests**

```js
assert.equal(buildPanelUrl('/api/factors', 'h1'), '/api/factors?tf=h1');
assert.match(buildBacktestQuery({ ...input, timeframe: 'm15' }).toString(), /tf=m15/);
```

- [ ] **Step 2: Run RED**

Run: `node --test test/dashboard-data.test.mjs`

- [ ] **Step 3: Implement request context**

Export `buildPanelUrl`. Indicators, factors, and backtest use `state.activeTF`. `switchTF` immediately refreshes indicators and factors. Each response echoes normalized `tf`; panel renderers ignore responses that no longer match the selected timeframe.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test && npm run typecheck`

Commit: `fix: align dashboard panels to active timeframe`

### Task 5: Timestamped FX observations

**Files:**
- Create: `src/domain/fx.ts`
- Create: `src/domain/fx.test.ts`
- Modify: `server.ts`
- Modify: `src/domain/backtest.ts`
- Modify: `src/domain/backtest.test.ts`

- [ ] **Step 1: Write failing alignment tests**

```ts
assert.equal(findFxAtOrBefore([{ ts: 90, mid: 1400 }, { ts: 110, mid: 1500 }], 100, 30)?.mid, 1400);
assert.equal(findFxAtOrBefore([{ ts: 110, mid: 1500 }], 100, 30), undefined);
```

- [ ] **Step 2: Run RED**

Run: `npm run build:test && node --test dist-test/src/domain/fx.test.js`

- [ ] **Step 3: Add storage and live horizon**

Create `fx_ticks(ts INTEGER PRIMARY KEY, bid REAL, ask REAL, mid REAL NOT NULL, source TEXT NOT NULL)`. Insert each successful FX refresh. `/api/factors` compares the newest eligible row with the row at or before the prior factor horizon instead of passing the same rate twice.

- [ ] **Step 4: Align historical FX**

Export `findFxAtOrBefore`. Backtest params accept `fxTicks`; premium uses only an FX observation at or before the candle within tolerance. Remove historical use of process-memory `krwUsdRate`.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test && npm run typecheck`

Commit: `fix: align fx observations by timestamp`

### Task 6: Executable backtest accounting

**Files:**
- Modify: `src/domain/backtest.ts`
- Modify: `src/domain/backtest.test.ts`
- Modify: `src/contracts/params.ts`
- Modify: `src/contracts/params.test.ts`
- Modify: `server.ts`
- Modify: `public/js/dashboard-data.mjs`

- [ ] **Step 1: Write failing execution tests**

Add tests proving that a bar touching both stop and target exits at stop, entry occurs at the next open, fees and slippage reduce equity, positive funding charges longs, and `annualizationBars('m1')` exceeds `annualizationBars('h1')`.

- [ ] **Step 2: Run RED**

Run: `npm run build:test && node --test dist-test/src/domain/backtest.test.js dist-test/src/contracts/params.test.js`

- [ ] **Step 3: Implement deterministic fills**

Add params `timeframe`, `feeRate`, `slippageBps`, and funding observations. Fill entries at next open, use high/low for exits with stop precedence, and apply leveraged price PnL, fees, slippage, and funding to equity.

- [ ] **Step 4: Correct metrics and API**

Compute bar returns at the selected frequency and annualize with the timeframe's Korean-session bars per year. Return `costs`, `coverage`, and echoed `tf`; normalize these fields without breaking the current UI.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test && npm run typecheck`

Commit: `fix: make backtest costs and fills executable`

### Task 7: Contaminated-tick audit and final verification

**Files:**
- Create: `scripts/audit-spot-ticks.mjs`
- Create: `test/audit-spot-ticks.test.mjs`
- Modify: `package.json`
- Modify: `public/js/dashboard-renderers.mjs`
- Modify: `public/css/signal-panel.css`

- [ ] **Step 1: Write failing cleanup classification test**

Test that weekday 19:00 KST and weekend rows are invalid, while weekday 09:00–18:00 KST rows are retained. Test dry-run output without mutating the test database.

- [ ] **Step 2: Run RED**

Run: `node --test test/audit-spot-ticks.test.mjs`

- [ ] **Step 3: Implement explicit audit/apply modes**

Add `npm run audit:ticks -- --db <path>` for dry-run and require `--apply --backup <path>` for deletion. Never target the production database implicitly.

- [ ] **Step 4: Render coverage**

Show omitted factors and freshness states in `factorCoverage`. Keep the last valid snapshot but label stale observations independently from SSE `LIVE`.

- [ ] **Step 5: Verify copied database and browser**

Run:

```bash
npm test
npm run typecheck
npm run audit:ticks -- --db /tmp/sk-hynix-review/ticks.db
git diff --check
```

Verify 1280x720, 1440x900, and 1920x1080: no overflow, active timeframe matches factor/backtest responses, stale sources are visible, charts are nonblank, and calculator/backtest remain usable.

- [ ] **Step 6: Commit**

Commit: `feat: expose market data quality in dashboard`
