# Market Routing Overlays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Naver the clean spot source, keep closed-market spot lines flat when no OTC exists, and let desktop users toggle Naver/Yahoo/Binance overlay lines with icon buttons.

**Architecture:** Remove Binance proxy pricing from spot tick storage, add pure helpers for closed-market flat candles and overlay source selection, then update the chart renderer to draw each selected source as its own line. Keep strategy/factor APIs Binance-first with Naver fallback.

**Tech Stack:** TypeScript Express backend, better-sqlite3, native HTML/CSS/ES modules, Lightweight Charts, Node test runner.

---

### Task 1: Keep Naver spot data clean

**Files:**
- Modify: `src/domain/market-quality.ts`
- Modify: `server.ts`
- Test: `src/domain/market-quality.test.ts`

- [x] Update `canRecordSpotTick` so fully closed Korean sessions are not recordable without fresh regular or OTC data.
- [x] Remove the Binance proxy branch in `recordTick`.
- [x] Verify that closed/no-OTC ticks are not inserted.

### Task 2: Build fixed Naver line after close

**Files:**
- Modify: `src/domain/candles.ts`
- Modify: `server.ts`
- Test: `src/domain/candles.test.ts`

- [x] Add a helper that extends spot candles with flat synthetic candles from the last valid spot/OTC close to now.
- [x] Use it in `naverChart` and Naver snapshots when market is closed and no fresh OTC exists.
- [x] Preserve real after-hours ticks when OTC exists.

### Task 3: Add multi-source overlay UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/css/main.css`
- Modify: `public/js/utils.js`
- Modify: `public/js/app.js`
- Modify: `public/js/dashboard-controller.mjs`
- Test: `test/dashboard-controller.test.mjs`

- [x] Replace the source dropdown with Naver/Yahoo/Binance icon toggle buttons.
- [x] Default overlays to Naver and Binance.
- [x] Fetch Naver/Yahoo primary snapshots as needed; Binance remains included in snapshots and does not require a separate primary request.

### Task 4: Render selected overlay lines

**Files:**
- Modify: `public/js/chart.js`
- Test: `test/chart-overlays.test.mjs`

- [x] Extract currency-aware line conversion for Naver/Yahoo/Binance.
- [x] Render each selected source as a dedicated line; hide unselected lines.
- [x] Keep Binance as the primary signal/auxiliary line, falling back to Naver support/resistance when needed.

### Task 5: Verify and commit

**Files:**
- Run all tests and static checks.
- Commit with a single focused message.
