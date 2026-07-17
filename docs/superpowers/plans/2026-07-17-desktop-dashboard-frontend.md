# Desktop Dashboard Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a Binance-inspired, desktop-only SK hynix trading dashboard with reliable SSE-first transport, explicit panel states, stable chart framing, and dense non-overlapping layout.

**Architecture:** Keep native browser modules. Add a pure transport controller and focused DOM renderers, leaving `app.js` as composition. Preserve the current uncommitted market-context and duplicate-calculator-removal work in `server.ts`, `public/js/app.js`, and `public/index.html`.

**Tech Stack:** HTML, CSS, JavaScript ES modules, Lightweight Charts 4.1.3, Node.js built-in tests, Express static serving, in-app browser verification.

---

## Shared-Edit Warning

Before every edit, re-read `git status` and the relevant diff. The workspace
already contains concurrent changes in `server.ts`, `public/js/app.js`, and
`public/index.html`. Do not revert or overwrite them. Commit new pure modules
separately before staging shared files.

### Task 1: Dashboard Transport Controller

**Files:**
- Create: `public/js/dashboard-controller.mjs`
- Create: `test/dashboard-controller.test.mjs`
- Modify: `public/js/utils.js`

- [ ] **Step 1: Write failing controller tests**

Create deterministic fakes for fetch, EventSource, intervals, and time. Test:

```js
test('starts with Naver and performs one bootstrap fetch', async () => {
  const harness = createHarness();
  const controller = createDashboardController(harness.dependencies);
  await controller.start();
  assert.deepEqual(harness.fetchUrls, ['/api/data?source=naver']);
  assert.deepEqual(harness.eventSourceUrls, ['/api/stream?source=naver']);
});

test('starts one fallback poll after SSE disconnect and stops it after recovery', async () => {
  const harness = createHarness();
  const controller = createDashboardController(harness.dependencies);
  await controller.start();
  harness.disconnectSse();
  assert.equal(harness.activeIntervals(30000), 1);
  harness.connectSse();
  assert.equal(harness.activeIntervals(30000), 0);
});

test('ignores a stale response after the selected source changes', async () => {
  const harness = createHarness({deferredFetch: true});
  const controller = createDashboardController(harness.dependencies);
  const first = controller.start();
  const second = controller.setSource('yahoo');
  harness.resolveFetch(0, {source: 'naver', serverTime: 1});
  harness.resolveFetch(1, {source: 'yahoo', serverTime: 2});
  await Promise.all([first, second]);
  assert.equal(controller.getState().snapshot.source, 'yahoo');
});
```

- [ ] **Step 2: Run RED**

Run: `node --test test/dashboard-controller.test.mjs`

Expected: failure because `dashboard-controller.mjs` does not exist.

- [ ] **Step 3: Implement the controller**

Export `createDashboardController(dependencies)` with injected `fetch`,
`createEventSource`, timer functions, `now`, and callbacks. Implement:

```js
const state = {
  source: 'naver', connection: 'connecting', snapshot: null,
  snapshotReceivedAt: 0,
  panelStatus: {indicators: 'loading', factors: 'loading', news: 'loading'},
};
```

Use a monotonically increasing request generation to ignore stale responses.
Only start the 30-second fallback interval when SSE is disconnected. Reconnect
at 2, 4, 8, 16, then 30 seconds. Expose `start`, `stop`, `setSource`,
`refreshSnapshot`, `markPanel`, and `getState`.

- [ ] **Step 4: Make Naver the single default**

Change `state.currentSource` in `public/js/utils.js` from `yahoo` to `naver`.

- [ ] **Step 5: Run GREEN and commit pure files**

Run: `node --test test/dashboard-controller.test.mjs`

Expected: all controller tests pass.

```bash
git add public/js/dashboard-controller.mjs test/dashboard-controller.test.mjs public/js/utils.js
git commit -m "fix: make dashboard transport SSE-first"
```

### Task 2: Integrate Controller and Independent Panel Refresh

**Files:**
- Modify: `public/js/app.js`
- Test: `test/dashboard-controller.test.mjs`

- [ ] **Step 1: Replace direct snapshot transport**

Remove `fetchData`, `connectSSE`, `currentEventSource`, and
`setInterval(fetchData, 10000)` from `app.js`. Instantiate the controller with:

```js
const dashboardController = createDashboardController({
  fetch: window.fetch.bind(window),
  createEventSource: (url) => new EventSource(url),
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  setInterval: window.setInterval.bind(window),
  clearInterval: window.clearInterval.bind(window),
  now: () => Date.now(),
  onSnapshot: applySnapshot,
  onConnection: renderConnectionState,
  onError: (message) => showError(message),
});
```

`applySnapshot` updates existing chart/header state without clearing the last
valid snapshot. `switchSource` delegates to `dashboardController.setSource`.

- [ ] **Step 2: Guard secondary requests**

Add one in-flight `AbortController` per indicators, factors, news, and health.
Abort the previous request before starting a newer request. A failed request
marks only its own panel stale/error.

- [ ] **Step 3: Pause schedules while hidden**

On `visibilitychange`, stop secondary timers while hidden. When visible, run one
refresh for indicators, factors, news, and health, then restore their schedules.

- [ ] **Step 4: Verify transport behavior**

Run: `npm test`

Expected: all tests pass and no unconditional 10-second snapshot timer remains
in `public/js/app.js`.

### Task 3: Focused Renderers and Supported Side Panel

**Files:**
- Create: `public/js/dashboard-renderers.mjs`
- Create: `test/dashboard-renderers.test.mjs`
- Modify: `public/js/app.js`
- Modify: `public/index.html`
- Modify: `public/css/signal-panel.css`

- [ ] **Step 1: Write failing renderer tests**

Use a minimal fake document implementation and test safe text rendering for:

- factor tags;
- indicator signals and explicit empty state;
- source health rows;
- connection state labels;
- market context fields already returned by `/api/factors`.

Assert external labels/headlines are assigned through `textContent` and never
interpolated into `innerHTML`.

- [ ] **Step 2: Run RED**

Run: `node --test test/dashboard-renderers.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement renderer functions**

Export `renderFactors`, `renderSignals`, `renderSourceHealth`,
`renderMarketContext`, `renderConnectionState`, and `renderPanelMessage`.
Render compact rows with semantic class names and no network calls.

- [ ] **Step 4: Integrate current market-context work**

Preserve the concurrent `marketContext` response and `app.js` rendering logic,
but move DOM construction into `dashboard-renderers.mjs`. Populate
`factorCoverage` from `/api/ticks`. Keep `riskArea` and `basisArea` hidden if the
corresponding response object is absent.

- [ ] **Step 5: Keep one calculator**

Preserve the concurrent removal of the duplicate side-panel calculator. Keep
the floating calculator and backtest controls. Remove obsolete exports and DOM
lookups that reference deleted `calcEntry`, `calcExit`, `calcResult`, or related
side-panel IDs.

- [ ] **Step 6: Run GREEN**

Run: `node --test test/dashboard-renderers.test.mjs && npm test`

Expected: renderer and full suites pass.

### Task 4: Stable Chart Framing and Local Dependency

**Files:**
- Modify: `public/js/chart.js`
- Modify: `public/js/app.js`
- Modify: `public/index.html`
- Create: `public/vendor/lightweight-charts.standalone.production.js`
- Create: `public/vendor/lightweight-charts.LICENSE`

- [ ] **Step 1: Add chart framing state**

Track whether each chart has completed initial framing. `pushData` calls
`setVisibleRange` only on initial load or after an explicit source/timeframe
reset. Live SSE updates call `series.update` or `setData` without resetting the
user-selected range.

- [ ] **Step 2: Vendor Lightweight Charts 4.1.3**

Download the exact 4.1.3 standalone production build from
`https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js`
and the Apache-2.0 license from
`https://raw.githubusercontent.com/tradingview/lightweight-charts/v4.1.3/LICENSE`
to `public/vendor`. Replace the `unpkg.com` script in `index.html` with:

```html
<script src="/vendor/lightweight-charts.standalone.production.js"></script>
```

- [ ] **Step 3: Add chart-unavailable state**

Before chart creation, detect a missing `window.LightweightCharts`. Show a fixed
chart error overlay and continue initializing non-chart controls.

- [ ] **Step 4: Verify**

Run: `rg -n "unpkg.com|fitContent\(\)" public`

Expected: no CDN reference; `fitContent()` appears only in explicit initial or
reset paths.

### Task 5: Binance-Inspired Desktop Layout

**Files:**
- Modify: `public/index.html`
- Modify: `public/css/main.css`
- Modify: `public/css/chart.css`
- Modify: `public/css/signal-panel.css`
- Modify: `public/css/calculator.css`

- [ ] **Step 1: Reorganize header markup**

Keep primary price, change, market state, latency, and source freshness in the
first scan line. Group previous close/high/low, Binance/funding, and indicators
as compact secondary metrics with stable widths.

- [ ] **Step 2: Apply Binance-like visual hierarchy**

Use existing variables with these rules:

```css
:root {
  --bg: #0b0e11;
  --surface: #181a20;
  --surface-raised: #1e2329;
  --border: #2b3139;
  --text: #848e9c;
  --text-bright: #eaecef;
  --yellow: #f0b90b;
}
```

Reserve yellow for selected controls and Binance-specific values. Keep cards at
6px radius or less. Use one-pixel dividers and compact 28-32px controls.

- [ ] **Step 3: Add desktop breakpoints**

At widths below 1366px reduce header gaps, hide only `.ticker-sub` and
`.refresh-label`, and keep primary values visible. At 1600px and above allow the
signal panel to expand to 420px. Do not add mobile layouts.

- [ ] **Step 4: Stabilize dimensions**

Give toolbar, header metric groups, chart overlay, side-panel controls, and
backtest inputs explicit min/max dimensions so dynamic labels cannot shift the
chart.

### Task 6: Cleanup, Automated Verification, and Desktop Browser QA

**Files:**
- Delete: `public/js/app-combined.js`
- Modify: tests only if verified behavior requires it

- [ ] **Step 1: Remove dead combined code**

Run: `rg -n "app-combined" . --glob '!node_modules/**' --glob '!dist*/**'`

Expected: no runtime reference. Delete `public/js/app-combined.js`.

- [ ] **Step 2: Run automated quality gates**

Run: `npm test && npm run typecheck && git diff --check`

Expected: zero failures and no whitespace errors.

- [ ] **Step 3: Start copied-database server**

Build and start an unused port with a copied SQLite database. Keep the existing
dashboard service untouched until verification succeeds.

- [ ] **Step 4: Verify three desktop viewports**

At 1280 x 720, 1440 x 900, and 1920 x 1080 verify:

- `document.documentElement.scrollWidth === clientWidth`;
- chart canvases have nonzero dimensions and nonblank pixels;
- header and toolbar bounding boxes do not overlap;
- source defaults to Naver;
- side panel scroll exposes factors, signals, and backtest;
- calculator and backtest return rendered results;
- console has no fresh errors or warnings.

- [ ] **Step 5: Verify transport**

Observe server clients and browser requests for at least one refresh interval.
Expected: one SSE client, no 10-second `/api/data` polling while connected, and
one fallback poll loop only after forced SSE disconnection.

- [ ] **Step 6: Commit shared-file integration**

After reviewing concurrent hunks, commit the shared HTML/app/server changes and
report their provenance separately from the new controller/renderer work.
