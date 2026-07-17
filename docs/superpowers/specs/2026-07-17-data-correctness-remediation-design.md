# Data Correctness Remediation Design

## Goal

Restore confidence in the dashboard's live factors and backtests by ensuring
that every observation has truthful time, currency, freshness, and trading
session semantics. Preserve the current desktop dashboard and existing API
surface while correcting the data pipeline underneath it.

## Scope

This remediation covers six connected correctness problems:

1. Stop cached after-hours quotes from being written as new spot ticks outside
   the declared Korean pre-market, regular, and after-hours sessions.
2. Prevent synthetic or stale Binance points from appearing current or
   participating in factors and risk decisions.
3. Keep spot and futures support/resistance levels in explicit currencies and
   convert them only at the presentation boundary.
4. Make chart, indicators, factors, and backtest use the same selected
   timeframe.
5. Store timestamped USD/KRW observations and use the observation available at
   each historical decision time.
6. Make backtest execution account for intrabar stops, fees, slippage, leverage,
   and funding cash flow.

The broader collector expansion described in the mixed-data-source design is
not part of this remediation. KIS, OpenDART, Twelve Data, industry proxies, and
FRED remain subsequent work after the current pipeline is trustworthy.

## Observation Model

New repository and domain helpers will use a canonical observation envelope:

```ts
interface MarketObservation<T> {
  instrument: string;
  source: string;
  exchangeTs: number;
  receivedTs: number;
  currency: 'KRW' | 'USD' | 'USDT';
  quality: 'live' | 'delayed' | 'stale' | 'synthetic';
  value: T;
}
```

Existing SQLite tables remain readable. Schema changes are additive: FX gets a
timestamped table, and data-quality metadata is added only where it is needed
to prevent ambiguous reads. No destructive migration runs automatically.

## Spot Collection Rules

`lastAfterHours` is display state, not a market observation. `recordTick` may
write only when the current KST session is pre-market, regular, or after-hours
and the upstream response contains a quote valid for that session. A cached
after-hours quote may be returned as the last valid display quote after the
session closes, but it must retain its original exchange timestamp and must not
be inserted again.

Existing contaminated rows will not be deleted silently. A deterministic audit
and cleanup command will identify rows outside valid sessions and produce row
counts before deletion. Cleanup must run against a backup or copied database
first; the application fix does not mutate historical data on startup.

Candles must not fabricate high/low values to create a visible body. Flat bars
remain flat. Until real exchange volume is collected, Naver candle volume is
named and treated as `sampleCount`; volume-based factors are ineligible for
Naver data rather than interpreting polling frequency as traded volume.

## Binance Freshness

Local Binance fallback returns the last real observation with its original
timestamp. It does not append flat points through the current time. API
responses expose `quality`, `ageSec`, and `lastExchangeTs` for Binance data.

The eligibility rule is explicit:

- mark/index/book-derived factors: maximum age 120 seconds;
- funding: maximum age is the funding interval or eight hours, whichever is
  smaller;
- hourly sentiment and OI: maximum age 7,200 seconds;
- historical alignment: use only an observation at or before the decision
  candle and within the factor-specific tolerance.

When a source is ineligible, its factor is omitted, not replaced with a neutral
zero that dilutes the composite. The response reports omitted factor names and
reasons. SSE connection state and market-data freshness remain separate states.

## Currency And Levels

Support and resistance responses carry `instrument`, `currency`, and `source`.
Spot levels remain KRW; futures levels remain USDT. They are never merged or
deduplicated numerically across currencies on the server. The chart selects the
levels matching the visible series and converts spot levels using the FX value
associated with the snapshot.

The premium and basis calculations assume the Binance contract price is
comparable to one SK hynix share converted to USD. That assumption is exposed
as contract metadata and covered by a validation test; if metadata is missing,
the premium factor is ineligible.

## Timeframe Contract

The selected timeframe is dashboard context. `switchTF` triggers indicators,
factors, and support/resistance refreshes using `?tf=<activeTF>`. Backtest
requests include the same timeframe unless the user explicitly selects another
one. Responses echo the normalized timeframe, and the frontend rejects a stale
response whose timeframe no longer matches the current selection.

Supported aliases remain `m1`, `m5`, `m15`, and `h1`. Server normalization is
the authority for range and interval values.

## Timestamped FX

An `fx_ticks` table stores `ts`, `bid`, `ask`, `mid`, and `source`. The current
Naver hourly quote may populate `mid` with null bid/ask until a minute-level
source is added. Live FX momentum compares the latest eligible observation with
an earlier observation at the factor horizon; it never passes the same value as
both current and previous.

Historical premium and basis use the most recent FX observation at or before
each spot timestamp within a bounded tolerance. If none exists, the cross-market
factor is omitted for that timestamp. Current process memory is not used to
price historical observations.

## Backtest Execution

Backtest inputs remain spot candles with aligned futures, sentiment, and FX
observations. Execution rules are deterministic:

- entries fill at the next bar open plus configurable slippage;
- long stops use bar low and take-profit uses bar high; short logic is inverse;
- if stop and target are both touched in one bar, the conservative stop outcome
  wins;
- entry and exit fees are charged using configurable maker/taker rates;
- funding cash flow is applied only at funding timestamps crossed while the
  position is open;
- leveraged PnL, fees, and funding all update equity consistently;
- Sharpe annualization uses bars per year for the selected timeframe and only
  returns corresponding to that bar frequency.

API output includes cost totals, selected timeframe, data coverage, and
train/test metrics. The UI labels results as insufficient when the out-of-sample
period has fewer than the configured minimum trades. Optimization cannot update
active parameters from contaminated or insufficient data.

## Minimal Architecture Boundaries

The implementation extracts pure, testable units without introducing separate
services:

- `src/domain/market-quality.ts`: session and freshness eligibility;
- `src/domain/levels.ts`: typed support/resistance and currency selection;
- `src/domain/fx.ts`: timestamp alignment;
- `src/domain/backtest.ts`: execution and accounting;
- `src/repositories/market-repository.ts`: SQLite reads/writes and cleanup audit;
- `server.ts`: scheduling and HTTP composition only for the touched paths.

Collector processes and worker threads are deferred. The boundaries above must
make that later split possible without changing domain APIs.

## Error Handling And UI

The dashboard continues showing the last valid snapshot during upstream
failures, but displays freshness beside each source. Direction and confidence
must not imply usability when required data is stale. A factor response includes
coverage and omitted factors; the side panel shows these states in compact rows.

Backtest errors remain inline. No blocking browser alerts are introduced. A
timeframe change aborts prior panel requests to prevent stale UI updates.

## Testing And Acceptance

Required regression coverage:

- cached after-hours values cannot create off-session database writes;
- flat observations create flat candles and sample counts are not treated as
  exchange volume;
- stale Binance values retain their timestamps and are excluded from factors;
- KRW and USDT levels remain separate and render at the correct converted value;
- indicator, factor, and backtest requests carry the active timeframe;
- FX alignment never selects a future observation;
- stop/target collision uses the conservative result;
- fees, slippage, leverage, and funding reconcile to final equity;
- Sharpe annualization changes with timeframe;
- copied-database cleanup reports and removes only invalid off-session rows.

Completion requires the full automated suite, typecheck, database cleanup dry
run, and browser verification at 1280x720, 1440x900, and 1920x1080. The current
dashboard must remain usable throughout the sequence.
