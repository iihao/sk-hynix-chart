# Confidence Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make displayed confidence a backtest-calibrated signal quality score that combines technical indicators and market impact factors.

**Architecture:** Keep raw factor strength as `rawConfidence`, then calculate calibrated `confidence` from raw strength, backtest performance, sample quality, and indicator/factor agreement. Extend API contracts additively so current consumers keep working while the dashboard can inspect calibration details.

**Tech Stack:** TypeScript domain modules, Express API, Node test runner, browser dashboard ES modules.

---

### Task 1: Add confidence calibration domain logic

**Files:**
- Modify: `src/domain/calibration.ts`
- Test: `src/domain/calibration.test.ts`

- [ ] **Step 1: Write tests**

Add tests proving tiny samples shrink confidence, bad backtests penalize it, and technical agreement lifts it.

- [ ] **Step 2: Implement calibration**

Add `calibrateSignalConfidence()` returning `rawConfidence`, calibrated `confidence`, indicator agreement, factor agreement, penalties, and note.

- [ ] **Step 3: Verify**

Run `npm run build:test && node --test dist-test/src/domain/calibration.test.js`.

### Task 2: Wire calibrated confidence into factors and strategy

**Files:**
- Modify: `server.ts`
- Modify: `src/domain/strategy.ts`
- Test: `src/domain/strategy.test.ts`

- [ ] **Step 1: Use calibrated confidence in `/api/factors`**

Keep `rawConfidence` from factor calculation and replace response `confidence` with calibrated confidence.

- [ ] **Step 2: Pass calibrated confidence into strategy advice**

Use calibrated confidence in `generateStrategy()` so action advice strength follows backtest reality.

- [ ] **Step 3: Verify**

Run focused domain tests.

### Task 3: Extend API and dashboard normalizer

**Files:**
- Modify: `src/contracts/api.ts`
- Modify: `src/contracts/validators.ts`
- Modify: `src/contracts/api.test.ts`
- Modify: `public/js/dashboard-data.mjs`
- Modify: `test/dashboard-data.test.mjs`

- [ ] **Step 1: Add optional response fields**

Expose `rawConfidence` and `confidenceCalibration` without removing existing `confidence`.

- [ ] **Step 2: Preserve fields in frontend normalizer**

Return the calibration fields for rendering/debugging.

- [ ] **Step 3: Verify**

Run contract and dashboard-data tests.

### Task 4: Full verification

**Files:**
- Verify all changed files.

- [ ] **Step 1: Typecheck**

Run `npm run typecheck`.

- [ ] **Step 2: Full test suite**

Run `npm test`.

- [ ] **Step 3: Frontend syntax and diff hygiene**

Run `for file in public/js/*.js public/js/*.mjs; do node --input-type=module --check < "$file" || exit 1; done` and `git diff --check`.
