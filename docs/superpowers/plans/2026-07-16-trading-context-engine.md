# Trading Context Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add market/event context, basis analytics, risk controls, and regime state to the live SK hynix contract reference workflow.

**Architecture:** Add a dedicated helper module for trading context computation, cover it with unit tests, then wire its outputs into `/api/factors` and the existing dashboard so the new context influences strategy generation instead of living as display-only metadata.

**Tech Stack:** Node.js, CommonJS, Express, better-sqlite3, node:test

---

## File Structure

- Create: `lib/trading-context.js`
- Create: `test/trading-context.test.js`
- Modify: `server.js`
- Modify: `public/index.html`

## Tasks

### Task 1: Build and test the trading-context helper

- Add helper functions for market session state, funding countdown, event freeze windows, basis snapshots, risk overlays, and regime selection.
- Add focused tests for each helper family.

### Task 2: Wire the helper into `/api/factors`

- Compute paired basis history from existing spot and Binance ticks.
- Compute `marketContext`, `basis`, `risk`, and `regime`.
- Feed those outputs into strategy generation so event risk, basis stress, and regime mode influence the live recommendation.

### Task 3: Surface the new context in the UI

- Add compact dashboard cards for market context and basis status.
- Extend the strategy and risk sections with regime, position size, risk caps, and trade-block reasons.
- Keep the existing layout intact while making the new status visible at a glance.

### Task 4: Verify end-to-end behavior

- Run `npm test`.
- Run `node --check server.js`.
- Run the server on a temporary port and confirm `/api/factors?tf=m15` returns the new fields.
