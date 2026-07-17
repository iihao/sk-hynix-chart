# Backend Correctness Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make backend factor, backtest, contract-funding, and closed-session streaming output correct and testable without breaking the existing dashboard API.

**Architecture:** Add focused pure TypeScript modules for API parameter parsing, contract calculations, and stream snapshot merging. Extend the existing factor and backtest domain modules so live and historical decisions share factor functions and aligned observations. Keep `server.ts` as the composition root and preserve its pre-existing uncommitted proxy/circuit-breaker changes.

**Tech Stack:** TypeScript, Node.js built-in test runner, Express 5, better-sqlite3, browser smoke verification.

---

## File Map

- Create `src/contracts/params.ts`: parse and validate backtest query values.
- Create `src/contracts/params.test.ts`: parameter boundary regression tests.
- Create `src/contracts/stream.ts`: complete-snapshot merge contract for closed-session updates.
- Create `src/contracts/stream.test.ts`: prevents partial Binance payloads from replacing spot data.
- Create `src/domain/contract.ts`: pure contract fee, funding, ROI, and liquidation estimate.
- Create `src/domain/contract.test.ts`: long/short and positive/negative funding tests.
- Modify `src/domain/backtest.ts`: aligned factor history, weighted entry score, finite metrics, forced-close equity.
- Create `src/domain/backtest.test.ts`: accounting, alignment, and weight-effect tests.
- Modify `src/domain/factors.ts`: expose a weighted composite helper and keep optional sentiment factors deterministic.
- Create `src/domain/factors.test.ts`: extended factor coverage and weight override tests.
- Modify `server.ts`: route composition only; preserve existing proxy/circuit-breaker changes.
- Modify `package.json`: include all compiled TypeScript tests in `npm test`.

### Task 1: Test Discovery and Backtest Parameter Contract

**Files:**
- Create: `src/contracts/params.ts`
- Create: `src/contracts/params.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Extend the test command to discover domain and contract tests**

Change the final TypeScript test segment in `package.json` to:

```json
"test": "npm run build && node --test test/*.test.js test/*.test.mjs && node --test dist/src/**/*.test.js"
```

- [ ] **Step 2: Write failing backtest query tests**

Create `src/contracts/params.test.ts` with tests for defaults, valid overrides,
non-finite values, and each documented range:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBacktestParams } from './params';

const defaults = {
  entryThreshold: 2,
  holdBars: 12,
  stopLossPct: 3,
  takeProfitPct: 5,
  leverage: 5,
};

describe('parseBacktestParams', () => {
  it('returns valid numeric overrides', () => {
    assert.deepEqual(parseBacktestParams({
      entryThreshold: '3.5', holdBars: '20', stopLossPct: '4',
      takeProfitPct: '9', leverage: '10',
    }, defaults), {
      entryThreshold: 3.5, holdBars: 20, stopLossPct: 4,
      takeProfitPct: 9, leverage: 10,
    });
  });

  it('uses defaults for omitted values', () => {
    assert.deepEqual(parseBacktestParams({}, defaults), defaults);
  });

  for (const [field, value] of [
    ['entryThreshold', '0.49'], ['holdBars', '2'], ['stopLossPct', '0'],
    ['takeProfitPct', '101'], ['leverage', '21'], ['leverage', 'Infinity'],
  ] as const) {
    it(`rejects invalid ${field}=${value}`, () => {
      assert.throws(() => parseBacktestParams({ [field]: value }, defaults), /INVALID_BACKTEST_PARAMS/);
    });
  }
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm run build && node --test dist/src/contracts/params.test.js`

Expected: build fails because `./params` does not exist.

- [ ] **Step 4: Implement the parser**

Create `src/contracts/params.ts` with a `BacktestRequestParams` interface, a
range table, finite-number parsing, integer enforcement for `holdBars` and
`leverage`, and errors prefixed with `INVALID_BACKTEST_PARAMS:`.

```ts
export interface BacktestRequestParams {
  entryThreshold: number;
  holdBars: number;
  stopLossPct: number;
  takeProfitPct: number;
  leverage: number;
}

const LIMITS = {
  entryThreshold: [0.5, 8], holdBars: [3, 500],
  stopLossPct: [0.1, 50], takeProfitPct: [0.1, 100], leverage: [1, 20],
} as const;

export function parseBacktestParams(
  query: Record<string, unknown>, defaults: BacktestRequestParams,
): BacktestRequestParams {
  const result = { ...defaults };
  for (const key of Object.keys(LIMITS) as Array<keyof BacktestRequestParams>) {
    if (query[key] == null || query[key] === '') continue;
    const value = Number(query[key]);
    const [min, max] = LIMITS[key];
    const requiresInteger = key === 'holdBars' || key === 'leverage';
    if (!Number.isFinite(value) || value < min || value > max || (requiresInteger && !Number.isInteger(value))) {
      throw new Error(`INVALID_BACKTEST_PARAMS: ${key}`);
    }
    result[key] = value;
  }
  return result;
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `npm run build && node --test dist/src/contracts/params.test.js`

Expected: all parameter tests pass.

- [ ] **Step 6: Commit the isolated contract**

```bash
git add package.json src/contracts/params.ts src/contracts/params.test.ts
git commit -m "test: enforce backtest parameter bounds"
```

### Task 2: Direction-Aware Contract Funding

**Files:**
- Create: `src/domain/contract.ts`
- Create: `src/domain/contract.test.ts`
- Modify: `server.ts:1950-2036` (line numbers may shift because of preserved user changes)

- [ ] **Step 1: Write failing funding tests**

Cover the payment matrix with `positionSize=1000`, `fundingRate=0.001`, and
`fundingCount=1`:

```ts
assert.equal(calculateContract({ ...base, direction: 'long', fundingRate: 0.001 }).fundingPnl, -1);
assert.equal(calculateContract({ ...base, direction: 'short', fundingRate: 0.001 }).fundingPnl, 1);
assert.equal(calculateContract({ ...base, direction: 'long', fundingRate: -0.001 }).fundingPnl, 1);
assert.equal(calculateContract({ ...base, direction: 'short', fundingRate: -0.001 }).fundingPnl, -1);
```

Also assert that `fundingCost` is `1` only for a payer and `0` for a receiver,
and that `NaN`, infinite, zero, or out-of-range required values throw a
`ContractValidationError`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build && node --test dist/src/domain/contract.test.js`

Expected: build fails because `contract.ts` does not exist.

- [ ] **Step 3: Implement the pure calculator**

Move fee and liquidation calculations from `server.ts` into
`src/domain/contract.ts`. Calculate funding as:

```ts
const directionSign = direction === 'long' ? -1 : 1;
const fundingPnl = positionSize * fundingRate * fundingCount * directionSign;
const fundingCost = Math.max(0, -fundingPnl);
const netPnl = pnl - totalFee + fundingPnl;
```

Validate all required values with `Number.isFinite`. Keep every existing return
field and add `fundingPnl`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run build && node --test dist/src/domain/contract.test.js`

Expected: all contract calculator tests pass.

- [ ] **Step 5: Integrate the route without staging unrelated server changes**

Import `calculateContract` and `ContractValidationError` into `server.ts`, remove
the local calculator implementation, and map validation errors to HTTP 400.
Unexpected errors return `{ error: 'CALCULATION_FAILED' }` with HTTP 500.

- [ ] **Step 6: Verify the HTTP contract**

Run a copied-database server and POST long/short positive/negative funding
fixtures to `/api/calculate`. Expected: signed `fundingPnl` follows the matrix
and all legacy fields remain present.

### Task 3: Backtest Accounting and Factor-Aware Entries

**Files:**
- Modify: `src/domain/factors.ts`
- Create: `src/domain/factors.test.ts`
- Modify: `src/domain/backtest.ts`
- Create: `src/domain/backtest.test.ts`

- [ ] **Step 1: Write failing accounting tests**

Use 52 candles at price `100`, with candle 50 at `110` and candle 51 at `120`,
and a volume spike at candle 50. Assert:

```ts
assert.equal(result.trades.length, 1);
assert.ok(result.metrics.totalReturn > 0);
assert.equal(result.equityCurve.at(-1), 10909.09);
assert.ok(Number.isFinite(result.metrics.profitFactor));
assert.equal(result.metrics.profitFactor, 999);
```

- [ ] **Step 2: Write failing factor-alignment tests**

Build a flat-price candle fixture where entry is possible only from a strong
aligned sentiment/funding factor. Assert that:

- a future sentiment row does not create a trade;
- the same row timestamped at or before the candle creates a trade;
- setting the corresponding factor weight to zero removes the trade;
- changing Binance/funding input changes the composite or trade result.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `npm run build && node --test dist/src/domain/factors.test.js dist/src/domain/backtest.test.js`

Expected: forced-close return is zero and weight/alignment assertions fail.

- [ ] **Step 4: Add a reusable weighted composite helper**

In `src/domain/factors.ts`, export:

```ts
export function calculateWeightedComposite(
  factors: Factor[], overrides: Record<string, number> = {},
): { composite: number; direction: 'long' | 'short' | 'neutral'; confidence: number } {
  let weightedScore = 0;
  let totalWeight = 0;
  for (const factor of factors) {
    const weight = overrides[factor.category] ?? factor.weight;
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightedScore += factor.score * weight;
    totalWeight += weight;
  }
  const composite = totalWeight ? weightedScore / totalWeight : 0;
  return {
    composite,
    direction: composite > 2 ? 'long' : composite < -2 ? 'short' : 'neutral',
    confidence: Math.min(100, Math.abs(composite) * 15),
  };
}
```

Use it inside `calculateAllFactors` so live and backtest weighting share the
same aggregation behavior.

- [ ] **Step 5: Align historical observations without lookahead**

In `src/domain/backtest.ts`, add cursor-based alignment helpers that advance
only while `row.ts <= candle.time`. Reject the aligned row when it is older than
`observationToleranceSec` (default 3600). Build factors from exported domain
factor functions using only candles up to the current index and the aligned
Binance/sentiment rows.

Extend `BacktestParams` with:

```ts
fxRate?: number;
observationToleranceSec?: number;
```

Use `calculateWeightedComposite(factors, weights)` for entry direction and the
existing `threshold` for the absolute composite threshold.

- [ ] **Step 6: Fix final accounting and finite metrics**

After forced close, push final equity into `equityCurve`. Change no-loss profit
factor handling to return `999` when gross profit is positive and zero when
there are no realized profits.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `npm run build && node --test dist/src/domain/factors.test.js dist/src/domain/backtest.test.js`

Expected: all accounting, alignment, and weight tests pass.

- [ ] **Step 8: Commit domain behavior**

```bash
git add src/domain/factors.ts src/domain/factors.test.ts src/domain/backtest.ts src/domain/backtest.test.ts
git commit -m "fix: make backtests factor-aware and finite"
```

### Task 4: Restore Expanded Live Factors

**Files:**
- Modify: `server.ts:1689-1730`
- Test: `src/domain/factors.test.ts`

- [ ] **Step 1: Add a failing extended-factor test**

Call `calculateAllFactors` with `longRatio`, `buyVol`, `sellVol`, `oiChange`,
and `priceChange`. Assert that categories `lsRatio`, `takerVol`, and
`openInterest` are present exactly once.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build && node --test dist/src/domain/factors.test.js`

Expected: fail if any optional factor is absent or duplicated.

- [ ] **Step 3: Derive live sentiment inputs in the route**

Read the two latest usable sentiment rows at or before `now`. Pass:

```ts
longRatio: latest.ls_long_pct,
buyVol: latest.taker_buy_vol,
sellVol: latest.taker_sell_vol,
oiChange: previousOi > 0 ? (latestOi - previousOi) / previousOi * 100 : undefined,
priceChange: previousClose > 0 ? (latestClose - previousClose) / previousClose * 100 : undefined,
```

Do not pass zero placeholders when data is missing.

- [ ] **Step 4: Add active weight overrides to the factor call**

Extend `calculateAllFactors` with optional `weights`, pass `activeWeights` from
the route, and keep the response shape additive.

- [ ] **Step 5: Verify live API output**

Run: `curl -fsS 'http://127.0.0.1:<test-port>/api/factors?tf=m5'`

Expected: when the copied database has sentiment rows, categories include
`lsRatio`, `takerVol`, and `openInterest`; otherwise the response reports only
available factors without fabricated values.

### Task 5: Preserve Spot State During Closed-Session Streaming

**Files:**
- Create: `src/contracts/stream.ts`
- Create: `src/contracts/stream.test.ts`
- Modify: `server.ts:866-916`
- Modify: `server.ts:2060-2082`

- [ ] **Step 1: Write the failing merge-contract tests**

Test that `mergeBinanceIntoSnapshot(previous, binance, now)` preserves `m1`,
`m5`, `m15`, `h1`, `source`, and `krwUsd`, replaces only `binance`, and updates
`serverTime`. Assert that missing previous spot data throws rather than
returning a partial snapshot.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build && node --test dist/src/contracts/stream.test.js`

Expected: build fails because `stream.ts` does not exist.

- [ ] **Step 3: Implement the snapshot contract**

Create a minimal `DashboardSnapshot` interface for the required complete fields
and implement `isCompleteDashboardSnapshot` plus `mergeBinanceIntoSnapshot`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run build && node --test dist/src/contracts/stream.test.js`

Expected: all stream contract tests pass.

- [ ] **Step 5: Cache complete snapshots per source**

In `server.ts`, maintain `lastSnapshotsBySource`. Update it after successful
`/api/data` responses and full `broadcast()` responses.

- [ ] **Step 6: Replace Binance-only payloads**

For each client source group during the closed-session timer:

1. use the cached complete snapshot;
2. if absent, fetch one complete snapshot for that source;
3. merge Binance data with `mergeBinanceIntoSnapshot`;
4. send the existing raw snapshot shape for frontend compatibility.

Do not send `{ binance, serverTime, krwUsd }` by itself.

- [ ] **Step 7: Verify closed-session behavior**

Connect an SSE client, capture one closed-session update, and assert that the
payload still contains `m1`, `m5`, `m15`, and `h1`.

- [ ] **Step 8: Commit isolated stream modules**

```bash
git add src/contracts/stream.ts src/contracts/stream.test.ts
git commit -m "test: define complete dashboard stream snapshots"
```

Do not stage `server.ts` until its pre-existing proxy/circuit-breaker changes
have been reviewed and explicitly included or separated.

### Task 6: Server Integration, Error Semantics, and Verification

**Files:**
- Modify: `server.ts`
- Modify: `src/contracts/api.ts`
- Modify: `src/contracts/validators.ts`
- Modify: `src/contracts/api.test.ts`

- [ ] **Step 1: Integrate bounded backtest parsing**

Replace `parseFloat(...) || default` in `/api/backtest` with
`parseBacktestParams(req.query, activeParams)`. Return HTTP 400:

```json
{"error":{"code":"INVALID_BACKTEST_PARAMS","message":"Invalid backtest parameters"}}
```

Keep the existing successful response field names.

- [ ] **Step 2: Update the backtest contract**

Make fields absent from the domain response optional in `BacktestResponse`,
require at least one of `sharpe` or `sharpeRatio` in the validator, and validate
that returned metric numbers are finite.

- [ ] **Step 3: Review preserved server changes before combining**

Inspect the proxy tunnel and Binance circuit-breaker diff for timeout cleanup,
chunked HTTP handling, credential handling, and fallback behavior. Fix defects
in scope, but retain the user's intended proxy and local-cache fallback.

- [ ] **Step 4: Run the complete automated suite**

Run: `npm test`

Expected: all legacy, browser-normalizer, contract, factor, backtest, funding,
parameter, and stream tests pass.

- [ ] **Step 5: Run type and diff checks**

Run: `npm run typecheck`

Expected: exit 0.

Run: `git diff --check`

Expected: no whitespace errors, including in preserved server changes.

- [ ] **Step 6: Run copied-database API smoke tests**

Start the compiled server with a copied database and unused port. Verify:

```text
GET  /api/data?source=naver       200, complete four-timeframe snapshot
GET  /api/factors?tf=m5           200, available extended factors
GET  /api/backtest?...            200, finite metrics and echoed params
GET  /api/backtest?leverage=999   400, structured validation error
POST /api/calculate               200, signed fundingPnl
GET  /api/stream                  complete snapshot events
```

- [ ] **Step 7: Smoke-test the existing dashboard**

Reload the dashboard and verify nonblank charts, price, indicators, factors,
backtest controls, and no fresh console errors. Confirm Binance circuit-open
fallback does not delay or clear Naver data.

- [ ] **Step 8: Present the server integration diff separately**

Because `server.ts` was dirty before implementation, report which hunks came
from the pre-existing proxy/circuit-breaker work and which came from this repair.
Do not commit or push the combined server file until the user requests submission.

