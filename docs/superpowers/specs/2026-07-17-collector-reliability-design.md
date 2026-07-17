# Collector Reliability Design

## Goal

Make every external market-data collector observable, bounded, and safe to
degrade so that dashboard availability never implies that underlying data is
fresh. This is phase one of the approved B-to-A sequence; the trading decision
workflow will consume the quality contract defined here.

## Scope

This phase covers:

- Binance REST transport selection and circuit breaking;
- retry and backoff rules for scheduled collectors;
- collector runtime state and a unified quality API;
- SSE behavior during collector degradation;
- graceful process shutdown;
- focused operational UI for source quality.

It does not add KIS, Twelve Data, OpenDART, FRED, or new industry sources. It
does not redesign factor scoring or the trading decision panel.

## Collector Runtime Contract

Each collector owns a runtime record:

```ts
type CollectorState = 'starting' | 'healthy' | 'degraded' | 'open' | 'stopped';

interface CollectorRuntime {
  key: string;
  state: CollectorState;
  transport: 'direct' | 'proxy' | 'local' | 'none';
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastExchangeTs: number | null;
  consecutiveFailures: number;
  nextRetryAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}
```

The runtime object records operational facts only. It does not overwrite the
exchange timestamp of the last valid observation. A successful HTTP response
without valid payload data is a failure.

## Binance Transport Selection

`BINANCE_PROXY` is optional. There is no implicit `127.0.0.1:7890` default.
When configured, a bounded probe checks the proxy before normal collection.
Transport order is:

1. configured, healthy proxy;
2. direct Binance endpoint;
3. last valid local SQLite observation.

All Binance endpoint hosts share one transport policy but maintain endpoint
attempt detail for diagnostics. A successful direct request makes direct the
preferred transport until it fails. A successful proxy request does the same
for proxy. The system does not probe every endpoint on every scheduled tick.

## Circuit Breaker

The Binance breaker uses three states:

- `closed`: normal requests are allowed;
- `open`: network calls are skipped and local data is returned;
- `half-open`: exactly one bounded probe is allowed after cooldown.

Three consecutive collection failures open the breaker. Initial cooldown is 30
seconds and doubles after each failed half-open probe to a maximum of five
minutes. A successful half-open probe closes the breaker and resets counters.
Concurrent requests share the same half-open probe promise; they cannot create
a retry stampede.

API errors that prove the request is invalid, such as an unknown symbol, open
the breaker immediately with a configuration error and do not retry alternate
hosts. Timeouts, DNS, proxy, and 5xx failures are retryable.

## Scheduler And Retry Rules

Every scheduled collector uses a non-overlapping task wrapper. If a prior run
is still active, the next interval records a skipped attempt rather than
starting another request.

Within one run, retry delays are bounded and jittered. Scheduled collectors do
not use unbounded loops. Backfill pagination has maximum pages and maximum
historical age per run, then continues on the next scheduled cycle.

The scheduler registry owns all timeout and interval handles. This allows tests
to assert active jobs and shutdown to stop them deterministically.

## Quality API

Add `GET /api/quality` returning:

```ts
interface QualityResponse {
  serverTime: number;
  overall: 'healthy' | 'degraded' | 'unavailable';
  collectors: CollectorRuntime[];
  sources: Array<{
    key: string;
    status: 'ok' | 'idle' | 'stale' | 'missing';
    ageSec: number | null;
    expectedActive: boolean;
    detail: string;
  }>;
}
```

`overall` is `unavailable` only when required spot data cannot produce a valid
dashboard snapshot. Binance degradation makes overall status `degraded`, not
unavailable. Source freshness continues to use exchange timestamps and session
expectations.

The existing `/api/ticks` endpoint remains compatible but is no longer the
frontend health authority.

## SSE Degradation

SSE connection state remains independent from source quality. When Binance is
degraded, snapshots continue with the last valid Binance object carrying stale
metadata; factors already omit ineligible observations. The server never
extends stale series to the current time.

SSE writes are guarded. A failed or closed response is removed without
interrupting the remaining clients. Periodic comment heartbeats keep idle
connections detectable without rebuilding full snapshots.

## Graceful Shutdown

The server retains the `http.Server` returned by `app.listen`. `SIGINT` and
`SIGTERM` trigger one idempotent shutdown sequence:

1. mark collectors stopped and reject new scheduled runs;
2. clear all registered timers;
3. stop accepting new HTTP connections;
4. end all SSE responses;
5. wait for in-flight collectors up to five seconds;
6. checkpoint WAL and close SQLite;
7. exit with success for signals or failure for startup/runtime fatal errors.

Tests call the shutdown coordinator directly and do not send real process
signals.

## Operational UI

The factor coverage area consumes `/api/quality`. It shows compact rows for
Naver, Binance, sentiment, FX, and news with `live`, `idle`, `stale`, or
`missing` semantics. Binance additionally shows `direct`, `proxy`, or `local`
transport and the next retry countdown when open.

The global header keeps displaying SSE state. It does not label the entire
dashboard offline when only Binance is degraded.

## Architecture Boundaries

Introduce focused modules without creating separate services:

- `src/infrastructure/circuit-breaker.ts`: deterministic state machine;
- `src/infrastructure/collector-runtime.ts`: task state and non-overlap wrapper;
- `src/infrastructure/scheduler.ts`: timer registry;
- `src/infrastructure/shutdown.ts`: idempotent shutdown coordination;
- `src/infrastructure/binance-transport.ts`: direct/proxy selection policy;
- `server.ts`: collector composition and HTTP route wiring.

All infrastructure modules accept injected time, timers, and request functions
for deterministic tests.

## Testing And Acceptance

Required tests prove:

- three retryable failures open the breaker;
- open state suppresses network calls;
- one half-open probe is shared by concurrent requests;
- cooldown doubles to five minutes and resets after success;
- configuration errors do not retry alternate endpoints;
- absent `BINANCE_PROXY` tries direct transport;
- configured proxy failure falls back to direct;
- scheduled tasks never overlap;
- quality response distinguishes SSE connectivity from source freshness;
- shutdown clears timers, closes SSE clients, checkpoints, and closes the DB
  exactly once;
- the current dashboard remains usable with Binance blocked.

Completion requires the full test suite, typecheck, browser-module syntax
checks, and browser verification at the three supported desktop sizes. Browser
verification must include forced Binance degradation with a live Naver chart
and visible retry state.
