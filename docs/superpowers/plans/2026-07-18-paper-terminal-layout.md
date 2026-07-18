# Paper Terminal Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the simulated trading UI from the right Quant panel to a Binance-style terminal directly below the chart.

**Architecture:** Keep the existing paper-trading API and accounting logic unchanged. Refactor only the desktop HTML/CSS/JS presentation: chart stays above, trading terminal becomes a bottom tab strip inside the chart area, and the right panel remains focused on decision support.

**Tech Stack:** Native HTML/CSS/ES modules, existing paper-trading REST API, Node test runner.

---

### Task 1: Layout guard

**Files:**
- Test: `test/paper-terminal-layout.test.mjs`

- [x] Assert that `paperTradingTerminal` appears after `chart-wrapper`.
- [x] Assert that `paperTradingTerminal` appears before `signalPanel`.

### Task 2: Move trading markup

**Files:**
- Modify: `public/index.html`

- [x] Remove the old right-panel “模拟交易” collapsible.
- [x] Add a Binance-style tabbed terminal immediately after `<!-- Chart -->` / `chart-wrapper`.
- [x] Add tabs for positions, open orders, order history, fills, ledger, position history, bot, and assets.

### Task 3: Terminal behavior and style

**Files:**
- Modify: `public/js/paper-trading.js`
- Modify: `public/js/app.js`
- Modify: `public/css/main.css`
- Modify: `public/css/signal-panel.css`

- [x] Add terminal tab switching.
- [x] Render existing account/positions/fills into the new panes.
- [x] Style the panel as a dense Binance-like dark desktop terminal.

### Task 4: Verification

- [x] Run layout test.
- [x] Run typecheck, JS syntax check, full test suite, diff checks, and commit.
