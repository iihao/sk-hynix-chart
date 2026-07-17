# Dashboard Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing dashboard indicators, factor direction, news, and backtest controls work against the single production `/api` contract without adding new data sources or UI features.

**Architecture:** Keep the existing production routes and trading algorithms for this stabilization slice. Define runtime response validators in TypeScript and a small browser-compatible normalization module so transport shapes are converted once before DOM rendering. Render all external text with DOM text APIs, then verify the compiled server with a copied SQLite database and the dashboard in a real browser.

**Tech Stack:** TypeScript 7, Node.js test runner, Express 5, browser ES modules, SQLite, in-app browser verification.

---

### Task 1: Make API contracts executable and testable

**Files:**
- Modify: `src/contracts/api.ts`
- Create: `src/contracts/validators.ts`
- Modify: `src/contracts/api.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing contract tests**

Replace live-server-dependent tests with deterministic response fixtures. Cover indicators, factors, backtest metrics, and malformed payload rejection:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBacktestResponse,
  parseFactorsResponse,
  parseIndicatorsResponse,
} from './validators';

describe('dashboard API contracts', () => {
  it('accepts the production indicators shape', () => {
    const value = parseIndicatorsResponse({
      rsi: [45],
      macd: { dif: [1], dea: [0.5], histogram: [1] },
      bollinger: { upper: [110], mid: [100], lower: [90] },
      ma5: [101], ma20: [100], volRatio: [1.2],
      latest: {
        rsi: 45, macdDif: 1, macdDea: 0.5, macdHist: 1,
        volRatio: 1.2, ma5: 101, ma20: 100,
        bollUpper: 110, bollLower: 90, macdState: 'bullish',
      },
      signals: [], support: [], resistance: [], times: [1],
    });
    assert.equal(value.latest?.rsi, 45);
  });

  it('accepts the production factor shape', () => {
    const value = parseFactorsResponse({
      factors: [{ category: 'momentum', label: 'Momentum', score: 2, weight: 0.9, detail: 'up' }],
      composite: 2,
      direction: 'long',
      confidence: 30,
    });
    assert.equal(value.direction, 'long');
  });

  it('accepts production backtest metric and trade names', () => {
    const value = parseBacktestResponse({
      params: { tf: '5m', entryThreshold: 2, holdBars: 12, stopLossPct: 3, takeProfitPct: 5, leverage: 5 },
      metrics: { totalReturn: 1, winRate: 40, profitFactor: 1.2, sharpeRatio: 0.3, maxDrawdown: 2, totalTrades: 5, avgHoldBars: 4, avgWin: 2, avgLoss: 1, expectancy: 0.2 },
      trades: [{ entryTime: 1, exitTime: 2, entryPrice: 100, exitPrice: 102, direction: 'long', pnlPct: 2, pnl: 10, exitReason: 'time_exit', bars: 4, positionSizePct: 30, sl: 98, tp: 104 }],
      equityCurve: [{ time: 1, equity: 10000 }], factorHistory: [], activeWeights: {}, activeParams: {},
    });
    assert.equal(value.metrics?.sharpeRatio, 0.3);
  });

  it('rejects malformed factor responses', () => {
    assert.throws(() => parseFactorsResponse({ factors: 'bad' }));
  });
});
```

- [ ] **Step 2: Run the tests and verify the new imports fail**

Run: `npm run build && node --test dist/src/contracts/api.test.js`

Expected: FAIL because `./validators` does not exist.

- [ ] **Step 3: Align TypeScript contracts with production payloads**

Update `IndicatorsResponse.latest` to allow `null`. Keep the current factor shape. Change backtest types to the production names:

```ts
export interface BacktestMetrics {
  totalReturn: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  totalTrades: number;
  avgHoldBars: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
}

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  direction: 'long' | 'short';
  pnlPct: number;
  pnl: number;
  exitReason: string;
  bars: number;
  positionSizePct: number;
  sl: number;
  tp: number;
}
```

- [ ] **Step 4: Implement boundary validators**

Create `src/contracts/validators.ts` with small assertion helpers. Validate only fields consumed by the dashboard, preserve extra server fields, and throw `Invalid API response: <field>` for invalid payloads:

```ts
import { BacktestResponse, FactorsResponse, IndicatorsResponse } from './api';

function object(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value as Record<string, any>;
}

function array(value: unknown, field: string): any[] {
  if (!Array.isArray(value)) throw new Error(`Invalid API response: ${field}`);
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value;
}

export function parseIndicatorsResponse(value: unknown): IndicatorsResponse {
  const data = object(value, 'indicators');
  array(data.rsi, 'rsi');
  array(data.signals, 'signals');
  if (data.latest != null) number(object(data.latest, 'latest').rsi, 'latest.rsi');
  return data as unknown as IndicatorsResponse;
}

export function parseFactorsResponse(value: unknown): FactorsResponse {
  const data = object(value, 'factors');
  array(data.factors, 'factors');
  number(data.composite, 'composite');
  number(data.confidence, 'confidence');
  if (!['long', 'short', 'neutral'].includes(data.direction)) throw new Error('Invalid API response: direction');
  return data as unknown as FactorsResponse;
}

export function parseBacktestResponse(value: unknown): BacktestResponse {
  const data = object(value, 'backtest');
  if (data.error) return data as BacktestResponse;
  array(data.trades, 'trades');
  const metrics = object(data.metrics, 'metrics');
  number(metrics.winRate, 'metrics.winRate');
  number(metrics.sharpeRatio, 'metrics.sharpeRatio');
  return data as BacktestResponse;
}
```

- [ ] **Step 5: Make the default test script self-contained**

Set scripts to build before running both legacy and contract tests:

```json
"test": "npm run build && node --test test/*.test.js dist/src/contracts/api.test.js",
"test:contract": "npm run build && node --test dist/src/contracts/api.test.js"
```

- [ ] **Step 6: Run tests and commit**

Run: `npm test`

Expected: existing 15 legacy tests plus contract tests pass.

Commit: `test: enforce dashboard API contracts`

### Task 2: Add a browser-compatible dashboard normalization layer

**Files:**
- Create: `public/js/dashboard-data.mjs`
- Create: `test/dashboard-data.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing normalization tests**

Test exact query parameter names, percentage semantics, metric aliases, and trade price fields:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBacktestQuery,
  normalizeBacktest,
  normalizeFactors,
  normalizeIndicators,
} from '../public/js/dashboard-data.mjs';

test('normalizes indicator latest values', () => {
  assert.equal(normalizeIndicators({ latest: { rsi: 45, macdHist: 1.2, volRatio: 1.1 } }).rsi, 45);
});

test('normalizes factor direction for display', () => {
  const result = normalizeFactors({ factors: [], composite: -2.5, direction: 'short', confidence: 55 });
  assert.deepEqual(result.direction, { code: 'short', label: '做空', score: -2.5, confidence: 55 });
});

test('uses production backtest query names', () => {
  assert.equal(buildBacktestQuery({ threshold: 2, hold: 12, stopLoss: 3, takeProfit: 5, optimize: false }).toString(),
    'entryThreshold=2&holdBars=12&stopLossPct=3&takeProfitPct=5&optimize=false');
});

test('does not multiply server win rate and maps trade prices', () => {
  const result = normalizeBacktest({ metrics: { winRate: 39.7, totalReturn: 1, sharpeRatio: 0.2 }, trades: [{ entryPrice: 100, exitPrice: 101, pnl: 5, direction: 'long' }] });
  assert.equal(result.metrics.winRate, 39.7);
  assert.equal(result.trades[0].entry, 100);
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `node --test test/dashboard-data.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the normalization module**

Implement pure functions that reject missing required values, map `long/short/neutral` to Chinese labels, build the exact production query, expose `sharpeRatio` as `sharpe`, and map `entryPrice/exitPrice` for rendering. Do not access DOM state in this module.

- [ ] **Step 4: Add the browser test to `npm test` and commit**

Update the test command to include `test/dashboard-data.test.mjs`.

Run: `npm test`

Expected: all legacy, contract, and dashboard normalization tests pass.

Commit: `feat: normalize dashboard API responses`

### Task 3: Repair dashboard rendering and interactions

**Files:**
- Modify: `public/js/app.js`
- Modify: `public/index.html`

- [ ] **Step 1: Import and use normalizers**

Import the four helpers from `./dashboard-data.mjs`. Update indicators to consume normalized `rsi`, `macdHist`, and `volRatio`. Update factor direction from the normalized `{ code, label, score, confidence }` structure.

- [ ] **Step 2: Render external text safely**

Replace news and factor `innerHTML` interpolation with `document.createElement` and `textContent`. Backtest numeric values may also use element construction; no external or API-provided string is inserted as HTML.

- [ ] **Step 3: Repair backtest controls**

Use `buildBacktestQuery`, display server win rate without multiplying it, display normalized Sharpe, and read normalized entry/exit values. When the API returns an error payload, show that message without attempting to render metrics.

- [ ] **Step 4: Add stable button IDs**

Set `id="btRunBtn"` and `id="btOptBtn"` on the existing buttons so the running/disabled state is visible and layout dimensions remain stable.

- [ ] **Step 5: Run automated verification and commit**

Run: `npm test && npm run typecheck`

Expected: all tests pass and TypeScript reports no errors.

Commit: `fix: restore dashboard data panels and backtest controls`

### Task 4: Runtime and browser verification

**Files:**
- No source changes expected; fix only defects reproduced by these checks.

- [ ] **Step 1: Build and launch against a copied database**

Copy `ticks.db` to a temporary directory and run compiled `dist/server.js` with a non-default `PORT` and `DATA_DIR`. Do not use the live project database.

- [ ] **Step 2: Verify API contracts**

Check `/api/indicators`, `/api/factors`, and a non-optimized `/api/backtest` request. Confirm the requested backtest parameters are echoed unchanged and the expected metric names are present.

- [ ] **Step 3: Verify the dashboard in a browser**

Open the temporary server, inspect console and network output, and confirm:

- charts render nonblank;
- RSI, MACD, and volume show numeric values;
- factor tags and direction leave their loading state;
- news text renders without HTML interpretation;
- backtest button disables while running and renders metrics without an alert;
- source switching reconnects SSE without duplicate active connections.

- [ ] **Step 4: Run final verification**

Run: `npm test && npm run typecheck && git diff --check`

Expected: zero failures and no whitespace errors in changed files.

- [ ] **Step 5: Commit any verification-only fix**

Commit only if runtime verification required an additional source fix, using `fix: address dashboard runtime verification findings`.
