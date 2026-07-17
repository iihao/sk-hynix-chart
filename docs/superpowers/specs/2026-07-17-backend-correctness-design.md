# Backend Correctness and Boundary Repair Design

Date: 2026-07-17

## Goal

Repair the backend paths that can currently produce misleading trading output,
while preserving the existing dashboard API and keeping the running dashboard
available. This delivery fixes backtest correctness, factor coverage, contract
funding calculations, and real-time message semantics. It also extracts the
smallest reusable backend boundaries needed to prevent the same regressions.

Frontend layout and visual redesign are explicitly deferred.

## Constraints

- Existing `/api/data`, `/api/factors`, `/api/backtest`, `/api/calculate`, and
  `/api/stream` consumers remain compatible.
- No new paid provider or API key is required.
- External provider failures must continue to fall back to stored data.
- The live dashboard must remain usable when Binance is unavailable.
- Existing uncommitted proxy and Binance circuit-breaker work in `server.ts`
  must be preserved and reviewed as an independent change.
- All trading calculations added or changed in this delivery require focused
  regression tests before implementation.

## Selected Approach

Use a staged repair rather than patching every issue inside `server.ts` or
rewriting the full service.

Pure calculations and transport contracts move into focused TypeScript modules.
`server.ts` remains the composition root for the current release, but route
handlers call the extracted modules. Provider adapters and SQLite repositories
are not fully migrated in this delivery.

## Domain Boundaries

### Factor Snapshot

Live strategy and backtest code consume one normalized snapshot shape:

```ts
interface FactorSnapshot {
  ts: number;
  factors: FactorSignal[];
  composite: number;
  direction: 'long' | 'short' | 'neutral';
  confidence: number;
  dataQuality: number;
}

interface FactorSignal {
  category: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
  asOf?: number;
  quality?: number;
}
```

The live `/api/factors` path must restore the available Binance sentiment
inputs: long/short ratio, taker buy/sell volume, and open-interest change.
Unavailable inputs are omitted or assigned zero effective weight; they are not
fabricated as neutral observations.

The first backtest repair uses the same factor calculator at each candle time.
It aligns each Binance and sentiment observation at or before the candle time
and rejects observations outside a documented tolerance. Entry decisions use
the weighted composite score. Weight changes must therefore be observable in a
deterministic test fixture.

### Backtest Accounting

The backtest engine must:

- append final equity after a forced close;
- calculate total return and drawdown from the complete equity curve;
- return a finite `profitFactor` in JSON (`null` is not a numeric metric);
- keep trade `pnlPct` unlevered for price-move reporting and use leverage only
  when updating account equity;
- reject non-finite or out-of-range parameters at the HTTP boundary;
- keep train/test alignment chronological and prevent future observations from
  entering a candle calculation.

When there are profits and no losses, `profitFactor` uses the finite upper cap
`999`. The cap is part of the API contract so optimizer scoring remains
serializable.

### Contract Funding

Funding cash flow is signed and direction-aware:

```text
positive rate: longs pay, shorts receive
negative rate: longs receive, shorts pay
```

The calculator returns both signed `fundingPnl` and compatibility field
`fundingCost`. `fundingCost` remains a positive amount only when the position
pays funding; received funding is represented by `fundingPnl > 0`.

### Real-Time Messages

SSE messages use a discriminated envelope:

```ts
type StreamMessage =
  | { type: 'snapshot'; data: DashboardSnapshot }
  | { type: 'binanceDelta'; data: BinanceDelta };
```

For compatibility, snapshot data retains the current dashboard fields. The
frontend migration will understand the envelope, while the backend will avoid
sending partial objects that look like full snapshots. Until the frontend part
is implemented, the server may send a merged full snapshot instead of a delta;
it must never overwrite spot state with Binance-only data.

## API Behavior

### `GET /api/factors`

Returns the existing response fields plus optional source-quality metadata.
The factors array includes all available normalized factors. Missing optional
sources reduce confidence.

### `GET /api/backtest`

Keeps existing query names. Parameters are parsed by a dedicated validator with
these initial limits:

| Parameter | Range |
|---|---:|
| `entryThreshold` | 0.5 to 8 |
| `holdBars` | 3 to 500 |
| `stopLossPct` | 0.1 to 50 |
| `takeProfitPct` | 0.1 to 100 |
| `leverage` | 1 to 20 |

Invalid parameters return HTTP 400 with a stable error code and do not start an
optimization job.

### `POST /api/calculate`

Keeps all existing response fields and adds signed funding information. Invalid
or non-finite numeric input returns HTTP 400.

### `GET /api/stream`

Preserves the endpoint and per-client source choice. The backend uses a typed
stream message builder and a cached last complete snapshot for closed-session
updates.

## Module Layout

```text
src/domain/backtest.ts          backtest signals and accounting
src/domain/factors.ts           normalized factor calculation
src/domain/contract.ts          fee, funding, liquidation estimate
src/contracts/stream.ts         SSE message contracts/builders
src/contracts/params.ts         API parameter parsing and validation
server.ts                       provider/storage composition and routes
```

Legacy JavaScript duplicates are not deleted in the same commit as correctness
changes. Their removal follows after the compiled TypeScript entrypoint has
integration coverage.

## Error Handling

- Provider errors are logged with source and operation but do not expose raw
  response bodies to API clients.
- Calculation errors use stable public messages; internal exception text is not
  returned for HTTP 500 responses.
- Optimizer failure leaves the previous active parameters unchanged.
- A stream client receives either a valid complete snapshot or no update.

## Test Strategy

### Unit tests

- forced-close equity is included in total return;
- profit factor is finite with no losing trades;
- changing factor weights changes deterministic backtest output;
- future Binance/sentiment observations are not used;
- positive and negative funding are correct for long and short positions;
- stream delta construction cannot masquerade as a full snapshot;
- backtest parameter bounds reject invalid values.

### Integration tests

- `/api/factors` includes available OI, taker, and long/short factors;
- `/api/backtest` returns finite JSON metrics and preserves query parameters;
- `/api/calculate` returns signed funding results;
- closed-session streaming preserves the last spot snapshot.

### Runtime verification

Run the compiled server against a copied SQLite database. Confirm the existing
dashboard still renders price, indicators, factors, and backtest output with
Binance online and with the circuit breaker open.

## Delivery Order

1. Add failing regression tests for accounting, weight use, funding, stream
   messages, and parameter validation.
2. Fix pure domain calculations.
3. Restore expanded factor inputs in the live route.
4. Replace partial SSE payloads with safe messages or merged snapshots.
5. Integrate route validation and consistent errors.
6. Run full tests, type checks, API probes, and dashboard smoke verification.

## Acceptance Criteria

- A forced-close profitable fixture reports positive total return.
- Every numeric backtest metric serializes as a finite JSON number.
- At least one deterministic fixture proves that factor weights and aligned
  Binance/sentiment inputs affect entries or exits.
- Live factors include available long/short, taker-volume, and OI signals.
- Long and short funding results match Binance payment direction.
- Closed-session updates cannot clear or zero the spot dashboard state.
- Existing tests pass and new high-risk paths have regression coverage.
- The production entrypoint builds without introducing new `@ts-nocheck` files.
