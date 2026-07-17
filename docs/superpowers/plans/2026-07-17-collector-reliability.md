# Collector Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore bounded Binance degradation, expose collector quality, and stop all scheduled work cleanly without compromising spot-data correctness.

**Architecture:** Add deterministic infrastructure modules for circuit state, collector runtime, scheduling, and shutdown. Compose them from `server.ts`, retain the existing SQLite fallback, and make `/api/quality` the frontend health authority.

**Tech Stack:** TypeScript, Node.js tests, Express, better-sqlite3, browser ES modules.

---

### Task 1: Circuit breaker state machine

**Files:**
- Create: `src/infrastructure/circuit-breaker.ts`
- Create: `src/infrastructure/circuit-breaker.test.ts`
- Modify: `server.ts`
- Modify: `src/domain/market-quality.ts`

- [ ] Write failing tests proving three failures open the circuit, open suppresses calls, half-open allows one shared probe, cooldown doubles to 300 seconds, and success resets state.
- [ ] Run `npm run build:test && node --test dist-test/src/infrastructure/circuit-breaker.test.js` and confirm RED.
- [ ] Export `createCircuitBreaker({now, failureThreshold, initialCooldownMs, maxCooldownMs})` with `execute`, `snapshot`, and `stop`.
- [ ] Restore `canRecordSpotTick` so closed sessions always return false; proxy prices remain Binance observations and never enter spot ticks.
- [ ] Replace disabled server globals with the breaker instance and keep SQLite fallback outside `execute`.
- [ ] Run focused tests and commit `fix: restore bounded Binance circuit breaking`.

### Task 2: Collector runtime and transport policy

**Files:**
- Create: `src/infrastructure/collector-runtime.ts`
- Create: `src/infrastructure/collector-runtime.test.ts`
- Create: `src/infrastructure/binance-transport.ts`
- Create: `src/infrastructure/binance-transport.test.ts`
- Modify: `server.ts`

- [ ] Write failing tests proving non-overlapping tasks, success/failure timestamps, direct use without proxy, and proxy-to-direct fallback.
- [ ] Run focused tests and confirm RED.
- [ ] Export `createCollectorRuntime` with `run`, `snapshot`, and `stop`; a concurrent `run` returns `{skipped:true}`.
- [ ] Export `createBinanceTransport({proxyUrl, directRequest, proxyRequest})`; absent proxy uses direct and configured proxy failure falls back to direct.
- [ ] Make `BINANCE_PROXY` optional and route `binanceFetch` through transport and breaker.
- [ ] Bound backfill to four pages per scheduled run.
- [ ] Run focused tests and commit `fix: bound collector transport and retries`.

### Task 3: Unified quality API

**Files:**
- Modify: `server.ts`
- Modify: `src/contracts/api.ts`
- Modify: `src/contracts/api.test.ts`
- Modify: `public/js/dashboard-renderers.mjs`
- Modify: `public/js/app.js`
- Modify: `test/dashboard-renderers.test.mjs`

- [ ] Add a failing contract test for `serverTime`, `overall`, collector runtime fields, and source freshness rows.
- [ ] Add `GET /api/quality`; overall is unavailable only when spot cannot form a valid snapshot and degraded when optional collectors fail.
- [ ] Replace `/api/ticks` health polling in the frontend with `/api/quality` and render state, transport, age, and next retry.
- [ ] Keep SSE connection text independent from quality text.
- [ ] Run tests and commit `feat: expose collector quality state`.

### Task 4: Scheduler registry and graceful shutdown

**Files:**
- Create: `src/infrastructure/scheduler.ts`
- Create: `src/infrastructure/scheduler.test.ts`
- Create: `src/infrastructure/shutdown.ts`
- Create: `src/infrastructure/shutdown.test.ts`
- Modify: `server.ts`

- [ ] Write failing tests proving registered timers clear once and shutdown closes HTTP, SSE, WAL, and DB exactly once.
- [ ] Export a scheduler registry with `setInterval`, `setTimeout`, and `stopAll` using injected timer functions.
- [ ] Export `createShutdownCoordinator` with an idempotent `shutdown(reason)` method and a five-second in-flight bound.
- [ ] Register every server timer, retain the `http.Server`, and wire `SIGINT`/`SIGTERM` to the coordinator.
- [ ] Add SSE heartbeats and remove failed clients without stopping the broadcast group.
- [ ] Run tests and commit `fix: stop collectors and storage gracefully`.

### Task 5: Verification and phase handoff

**Files:**
- Modify tests only when a verified contract requires it.

- [ ] Run browser-module syntax checks, `npm test`, `npm run typecheck`, `git diff --check`, and production audit.
- [ ] Start a copied-database server with Binance blocked; verify Naver remains usable and `/api/quality` shows Binance degraded/open with local transport.
- [ ] Verify 1280x720, 1440x900, and 1920x1080 have no overflow, nonblank charts, visible quality rows, and clean console.
- [ ] Push to `master` under the established direct-master workflow.
