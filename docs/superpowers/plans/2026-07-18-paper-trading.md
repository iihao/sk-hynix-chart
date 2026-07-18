# Paper Trading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Binance-style paper trading panel that tracks simulated account equity, positions, PnL, TP/SL settlement fills, and manual close-all.

**Architecture:** Put PnL and settlement math in `src/domain/paper-trading.ts`, persist account/positions/fills in SQLite tables owned by `server.ts`, expose `/api/paper/*` endpoints, and render a Binance-inspired panel through a focused frontend module. The system uses Binance futures mark/last price only for simulation and never sends real Binance orders.

**Tech Stack:** TypeScript domain logic, Express REST endpoints, better-sqlite3 persistence, native ES modules, existing Binance futures quote pipeline.

---

### Task 1: Paper trading domain

**Files:**
- Create: `src/domain/paper-trading.ts`
- Create: `src/domain/paper-trading.test.ts`

- [x] Define account, position, fill, and order input types.
- [x] Add `openPaperPosition`, `closePaperPosition`, `markPaperPosition`, and `findTriggeredExit`.
- [x] Test long/short PnL, insufficient margin rejection, and TP/SL triggers.

### Task 2: Server persistence and API

**Files:**
- Modify: `server.ts`

- [x] Create `paper_account`, `paper_positions`, and `paper_fills` tables.
- [x] Expose account read/update, order open, single close, close-all, fills list, and mark-to-market summary endpoints.
- [x] Add a scheduler that checks open positions against latest Binance price and records TP/SL settlement fills.

### Task 3: Binance-style frontend panel

**Files:**
- Modify: `public/index.html`
- Create: `public/js/paper-trading.js`
- Modify: `public/js/app.js`
- Modify: `public/css/signal-panel.css`

- [x] Add a collapsible “模拟交易” section in the right panel.
- [x] Render account equity, available balance, unrealized/realized PnL, positions, order form, close buttons, and recent fills.
- [x] Poll paper account state and submit simulated orders through the new API.

### Task 4: Verification

**Files:**
- Run `npm run typecheck`
- Run frontend JS syntax checks
- Run `npm test`
- Commit the feature.
