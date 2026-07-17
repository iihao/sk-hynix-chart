# Mixed Free Market Data Integration Design

Date: 2026-07-17

## Goal

Add a zero-monthly-cost market-data pipeline that improves SK hynix spot and
`SKHYNIXUSDT` contract analysis. The first delivery covers collection,
persistence, backend APIs, and factor integration. It does not add new frontend
views or order execution.

## Constraints

- Monthly paid-data budget is at most USD 10. The selected providers require no
  paid subscription.
- Free account registration and API keys are acceptable.
- The application must remain usable when every optional API key is absent.
- External data must be validated before it enters storage or factor logic.
- Live and backtest calculations must consume the same normalized records.
- No third API version will be introduced. Existing `/api` and `/api/v2`
  duplication must be resolved before the new sources are connected.

## Selected Providers

| Data | Primary | Fallback | Cost |
|---|---|---|---:|
| SK hynix and Samsung spot | Korea Investment Securities Open API | Naver Finance | Free/account required |
| USD/KRW | Twelve Data Basic | Naver market index | Free |
| SKHYNIXUSDT futures | Binance public WebSocket and REST | Binance REST snapshots | Free |
| Company disclosures | OpenDART | Last valid stored events | Free |
| MU, NVDA, SOXX proxies | Twelve Data Basic batch requests | Yahoo delayed data | Free |
| Semiconductor cycle | FRED | Last valid stored observation | Free |

Korea Investment Securities is optional. When its credentials are absent, the
spot provider starts in Naver fallback mode. Naver and Yahoo are best-effort
fallbacks and must not be represented as licensed exchange feeds.

## Architecture

```text
External providers
  -> provider validation and normalization
  -> SQLite repositories
  -> market snapshot service
  -> factor and risk services
  -> HTTP APIs
```

Each provider owns authentication, quota handling, transport, response
validation, and normalization. Providers do not calculate trading scores.
Repositories do not know provider-specific response shapes. Factor services
read normalized repository records and never call external APIs directly.

The dependency direction is:

```text
HTTP and jobs -> application services -> domain contracts <- providers/storage
```

## Provider Contract

Every observation includes:

```ts
interface ObservationMeta {
  source: string;
  symbol: string;
  eventTs: number;
  receivedTs: number;
  qualityStatus: 'ok' | 'degraded' | 'stale';
  session: 'pre' | 'regular' | 'after' | 'closed' | 'continuous';
  rawReference?: string;
}
```

Provider failures update source health but do not write zero-valued market
records. A fallback result identifies both the active source and `fallbackFrom`.

## Collection Schedule

| Provider | Method | Schedule |
|---|---|---|
| KIS SK hynix/Samsung | WebSocket | Real time while the relevant KRX session is active |
| Naver spot | REST | Every 60 seconds only when KIS is unavailable |
| Twelve Data USD/KRW | REST | Every 2 minutes during KRX pre, regular, and after sessions |
| Naver USD/KRW | REST | Every 10 minutes when Twelve Data is unavailable |
| Binance price/trade/book/liquidation | WebSocket | Real time |
| Binance mark/index/OI/funding | REST | Startup backfill and 5-minute snapshots; 30-second price fallback after disconnect |
| OpenDART | REST | Poll every 10 minutes and deduplicate by receipt number |
| MU/NVDA/SOXX | Twelve Data batch REST | Every 5 minutes during the US regular session |
| FRED | REST | Once daily |

The Twelve Data plan allows 800 API calls per day. The scheduler targets 270 to
320 daily calls by limiting USD/KRW collection to Korean trading sessions and
batching US proxy symbols. It stops optional proxy polling before exceeding a
configurable daily reserve.

## Persistence

Add these logical tables through explicit, versioned migrations:

### `stock_quotes`

Stores spot last price, cumulative volume, turnover, bid, ask, bid/ask sizes,
market state, and observation metadata. Fields unavailable from Naver remain
`NULL`. Quote sample counts are never used as trading volume.

### `fx_quotes`

Stores timestamped USD/KRW bid, ask, and midpoint. Historical basis calculations
join the closest valid FX observation within a configured tolerance instead of
reusing the current exchange rate.

### `futures_quotes`

Stores Binance last, mark, index, best bid/ask, open interest, funding rate, and
next funding time. The three price concepts remain separate.

### `futures_events`

Stores high-volume event streams such as aggregate trades and liquidations.
Events use provider event IDs when available and a deterministic composite key
otherwise.

### `company_events`

Stores OpenDART receipt number, corporation code, report type, title, published
time, and source URL. Receipt number is unique.

### `industry_observations`

Stores proxy and FRED observations with observation date, published/retrieved
timestamps, value, unit, and revision metadata. Backtests select the value known
at the simulated time so later revisions do not leak into history.

All time-series tables have a uniqueness constraint covering source, symbol,
and provider event time. Writes use transactions. Retention is configurable by
data class; aggregate trades and liquidations have a shorter default retention
than quotes and events.

## Session-Aware Interpretation

- During the KRX regular session, spot price, real volume, and order-book data
  provide the primary direction signal. Binance confirms direction and tracking.
- After the KRX close, spot technical indicators are frozen. Binance is measured
  against the official close as an implied next-session gap, not an immediately
  arbitrageable basis.
- Before the KRX open, the implied gap is combined with USD/KRW and overnight US
  semiconductor proxy returns.
- On weekends and exchange holidays, futures-derived direction receives a lower
  quality score because the underlying market is not executable.

The KRX calendar and exceptional halt state must come from the primary spot
provider where available. A weekday clock alone is not sufficient.

## Price Decomposition

The cross-market relationship is split into independent measures:

```text
trackingGap      = binanceIndexPrice - alignedSpotUsd
perpetualPremium = binanceMarkPrice - binanceIndexPrice
tradeDislocation = binanceLastPrice - binanceMarkPrice
```

`trackingGap` is primarily a consistency and risk signal. It is not counted a
second time as directional alpha. Historical spot conversion uses aligned
`fx_quotes` data.

## Factor Model

Factors are grouped and capped:

| Group | Maximum composite weight |
|---|---:|
| Spot price and microstructure | 30% |
| Futures structure and flow | 30% |
| Cross-market proxies and FX | 25% |
| Company events and industry cycle | 15% |

Every factor uses this contract:

```ts
interface FactorSignal {
  id: string;
  group: 'spot' | 'futures' | 'crossMarket' | 'eventCycle';
  score: number;
  baseWeight: number;
  quality: number;
  effectiveWeight: number;
  asOf: number;
  evidence: string[];
  warnings: string[];
}
```

Scores are clamped to `[-10, 10]`. Quality is clamped to `[0, 1]` and reflects
freshness, completeness, source tier, session applicability, and time-series
continuity. `effectiveWeight = baseWeight * quality`. Missing inputs produce
zero effective weight rather than fabricated neutral values.

Directional alpha, confidence, risk, and execution are separate outputs:

- Alpha estimates direction.
- Confidence represents evidence agreement and data quality.
- Risk can block or reduce a trade based on event windows, volatility, funding,
  liquidity, and extreme tracking gaps.
- Execution captures spread, depth, expected slippage, and funding cost.

FRED monthly observations affect the market regime only. They cannot directly
trigger minute-level entries. DART events primarily modify risk and confidence.

## HTTP API

The implementation keeps one public contract:

```text
GET /api/data-sources
GET /api/market-context?tf=m5
GET /api/factors?tf=m5
GET /api/events?limit=50
GET /api/industry-cycle
```

`GET /api/factors` returns:

```json
{
  "asOf": 0,
  "session": "regular",
  "alpha": {
    "score": 0,
    "direction": "neutral",
    "confidence": 0
  },
  "groups": [],
  "risk": {},
  "dataQuality": {
    "score": 0,
    "missing": [],
    "stale": []
  }
}
```

Error responses use a consistent `{ error: { code, message, details? } }` shape.
External provider error bodies and secrets are never returned to clients.

## Configuration and Secrets

Configuration is read from environment variables:

```text
DATA_DIR
KIS_APP_KEY
KIS_APP_SECRET
KIS_ACCOUNT_NO
TWELVE_DATA_API_KEY
OPENDART_API_KEY
FRED_API_KEY
```

An `.env.example` documents these names without values. Missing credentials
disable only their provider. Logs show provider enabled/disabled state, not
keys, tokens, account numbers, or complete third-party payloads.

## Resilience and Quota Handling

- External requests have bounded timeouts and validate status, content type,
  schema, timestamp, and numeric ranges.
- Authentication errors disable the provider until configuration changes.
- Rate-limit responses honor `Retry-After` and update quota health.
- Transient network failures retry at most twice with exponential backoff and
  jitter before opening a short circuit.
- WebSocket reconnects back off and perform a bounded REST backfill after
  recovery.
- Last valid data may be returned as stale, with factor quality decaying by age.
- Shutdown closes WebSockets, schedulers, and database connections.

## Migration Prerequisite

Before new providers are connected:

1. Choose one production API contract and eliminate the current `/api` and
   `/api/v2` behavioral fork.
2. Make production routes call the extracted domain modules.
3. Remove duplicate indicator, factor, strategy, and backtest implementations
   from `server.ts` as each module is migrated.
4. Correct existing frontend request and response contract mismatches.
5. Remove `@ts-nocheck` after the affected boundaries are typed.

This is required to prevent new provider data from feeding a third scoring
implementation.

## Testing

1. Provider parser tests use recorded fixtures and no live network.
2. Repository tests use temporary SQLite databases and cover migrations,
   deduplication, transactions, time alignment, and revision handling.
3. Factor tests cover quality decay, group caps, missing inputs, and session
   transitions.
4. API contract tests cover the single `/api/factors` response schema and error
   shape.
5. Degradation tests prove KIS-to-Naver fallback with the correct source and
   lower quality.
6. Quota tests prove the Twelve Data scheduler preserves the daily reserve.
7. Backtest tests prove live and historical paths consume the same normalized
   records and reject future revisions.
8. Startup tests prove the service remains usable with all optional keys absent.

## Acceptance Criteria

- With no optional keys, Naver and Binance provide the existing basic service.
- Configured providers expose last success, freshness, quota, active fallback,
  and failure reason through `/api/data-sources`.
- Closed sessions do not create repeated spot candles.
- Real market volume is distinct from quote sample count.
- Historical basis uses timestamp-aligned FX, spot, index, and mark values.
- OpenDART polling is idempotent by receipt number.
- FRED revisions do not leak into historical decisions.
- Group caps prevent correlated Binance signals from dominating the composite.
- Missing or stale data lowers confidence and effective weight.
- No real credentials or sensitive provider payloads exist in source control or
  application logs.
- Unit, integration, API contract, type-check, and build verification pass.

## Out of Scope

- Frontend redesign or new dashboard panels.
- Broker order submission or automated execution.
- Paid market-data subscriptions above the stated budget.
- Scraping paid DRAM/NAND price databases.
- Microservice decomposition; the implementation remains a modular monolith.
