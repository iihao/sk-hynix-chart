# Desktop Dashboard Frontend Optimization Design

Date: 2026-07-17

## Goal

Make the existing SK hynix trading dashboard reliable, dense, and readable on
desktop displays without changing its terminal-style visual identity or adding
a frontend framework. The work covers data transport, UI state, supported
decision panels, chart framing, and desktop layout behavior.

Mobile and tablet layouts are explicitly out of scope.

## Supported Viewports

The dashboard must remain fully usable at:

- 1280 x 720
- 1440 x 900
- 1920 x 1080

At each size, the active chart, source selector, primary price, market status,
factor panel, calculator, and backtest controls must be reachable without page
scrolling. The signal panel may scroll internally.

## Constraints

- Keep the current native HTML, CSS, and JavaScript module stack.
- Preserve existing API endpoints and successful response shapes.
- Keep the existing dark, work-focused trading-terminal aesthetic.
- Do not add marketing content, decorative illustration, or card-heavy layout.
- Do not implement frontend-only trading logic that disagrees with backend
  factors, risk, or backtest calculations.
- Unsupported strategy, risk, basis, or coverage sections must be hidden rather
  than displayed as empty placeholders.
- Existing calculator and backtest workflows must continue to work.

## Selected Approach

Use a focused native-module refactor. Introduce one controller for transport and
refresh lifecycle, keep normalization in `dashboard-data.mjs`, and keep DOM
rendering in `app.js` and focused renderer modules. This avoids a framework
migration while removing overlapping requests and implicit state transitions.

## Data Flow

### Bootstrap

1. Initialize charts and render explicit loading states.
2. Fetch one complete snapshot for the selected source.
3. Open the source-bound SSE connection.
4. Fetch indicators, factors, news, and source health independently.

The default source is `naver` in both HTML and JavaScript state. The dashboard
must not issue a Yahoo request before the user selects Yahoo.

### Live Updates

SSE is the primary market snapshot transport. The current unconditional
10-second full HTTP polling is removed.

When SSE disconnects:

- reconnect with exponential backoff from 2 to 30 seconds;
- run a non-overlapping 30-second HTTP fallback poll while disconnected;
- stop fallback polling immediately after SSE recovers;
- keep the last valid snapshot visible and mark it stale instead of clearing it.

Every request family has an in-flight guard. A slower response cannot overwrite
a newer response or a user-initiated source change.

### Secondary Data

- indicators: every 30 seconds;
- factors and source health: every 60 seconds;
- news: every 5 minutes;
- pause scheduled refreshes while the document is hidden and refresh once when
  it becomes visible again.

Failures remain local to their panel. Indicator failure does not prevent price
or factor updates.

## Frontend State

The controller owns:

```js
{
  source: 'naver',
  connection: 'connecting' | 'live' | 'fallback' | 'offline',
  snapshot: null,
  snapshotReceivedAt: 0,
  panelStatus: {
    indicators: 'loading' | 'ready' | 'stale' | 'error',
    factors: 'loading' | 'ready' | 'stale' | 'error',
    news: 'loading' | 'ready' | 'stale' | 'error'
  }
}
```

State changes are applied through explicit controller functions. Renderers
receive normalized values and do not initiate network requests.

## Module Boundaries

```text
public/js/dashboard-data.mjs       response normalization and validation
public/js/dashboard-controller.mjs transport, timers, source changes, freshness
public/js/dashboard-renderers.mjs  factors, signals, health, status, empty/error UI
public/js/app.js                    composition, charts, calculator/backtest wiring
public/js/chart.js                  chart creation and viewport updates
public/js/calculator.js             contract calculator workflow
public/js/utils.js                  shared state-independent formatting helpers
```

`app-combined.js` is not loaded and must be removed after a search confirms no
consumer references it. Event listeners move out of inline HTML only when the
affected control is already being edited; wholesale markup conversion is not
required in this delivery.

## Information Architecture

### Header

The first scan line contains ticker, primary price, percentage move, session
state, latency, and source freshness. Secondary values contain previous close,
high, low, Binance price, funding, RSI, MACD, and volume ratio.

At 1280 pixels, spacing and secondary labels tighten before any primary value is
hidden. Low-priority refresh text and ticker subtitle may collapse. Typography
uses fixed desktop sizes and must not scale with viewport width.

### Toolbar and Chart

Timeframe, source, and currency controls remain in one stable 40-pixel toolbar.
The chart consumes all remaining vertical space. Chart updates preserve the
user's manually selected visible range; automatic latest-bar framing runs only
on initial load, timeframe change, or source change.

Loading and provider failure states appear as overlays inside the chart region
without changing its dimensions.

### Signal Panel

The panel remains an overlay and uses an internal scroll area. It contains only
sections with working data:

1. direction and confidence;
2. market/source health;
3. available factors;
4. indicator signals;
5. calculator;
6. backtest.

The hidden strategy section remains hidden until a backend strategy contract is
available. `factorCoverage` renders source health from `/api/ticks` and the
current snapshot. `riskArea` and `basisArea` remain hidden because no dedicated
backend contract currently supports them. No section may render an empty title
with no content.

## Source Health and Staleness

Use `/api/ticks`, snapshot metadata, and response timestamps to render compact
health rows for Naver and Binance. Health presentation includes source, age,
fallback/local status, and whether the Korean market is open.

Staleness changes presentation only. It does not fabricate prices or scores:

- live: snapshot age <= 15 seconds;
- delayed: 15 to 60 seconds;
- stale: greater than 60 seconds;
- offline: no valid snapshot.

## Error Handling

- Replace blocking `alert()` usage in calculator and backtest flows with the
  existing non-blocking toast/status area.
- Preserve last valid values during transient failures.
- Show a retry command only where a user action is useful.
- Normalize API validation errors into concise user-facing text.
- If the chart library cannot load, show a visible chart-unavailable state and
  keep calculator, factors, and backtest accessible.

## Chart Dependency

Pin Lightweight Charts locally under `public/vendor` with its license notice.
The page must not depend on `unpkg.com` for first render. The version remains
4.1.3 during this delivery to avoid an unrelated chart API migration.

## Testing

### Unit Tests

- controller starts with Naver and performs one bootstrap snapshot request;
- connected SSE disables fallback polling;
- disconnect enables one non-overlapping fallback poll;
- stale responses cannot replace a newer source or snapshot;
- partial panel failures preserve other ready states;
- renderer functions use safe DOM text and show deterministic empty/error UI;
- chart framing does not reset after every live update.

### Browser Verification

At 1280 x 720, 1440 x 900, and 1920 x 1080:

- chart canvases are nonblank;
- no horizontal document overflow;
- header and toolbar values do not overlap;
- signal panel opens, scrolls, and exposes calculator/backtest controls;
- 11 or more available factors render when backend data is present;
- signals render or show an explicit empty state;
- source switch reconnects exactly one SSE client;
- no fresh console errors or unhandled promise rejections occur.

## Delivery Order

1. Add controller and renderer unit tests around current behavior.
2. Implement the transport controller and Naver-first bootstrap.
3. Extract renderers and panel states.
4. Fix chart framing and localize the chart dependency.
5. Tune the desktop header, toolbar, chart, and side panel at the three target
   viewports.
6. Remove dead combined frontend code after reference verification.
7. Run automated and browser verification with a copied database.

## Acceptance Criteria

- No unconditional 10-second full snapshot polling remains while SSE is live.
- Initial load uses Naver and does not contact Yahoo unless selected.
- A disconnect keeps the last chart visible and starts one fallback poll loop.
- Repeated live updates do not reset a user's chart range.
- Unsupported panel sections are not visibly empty.
- All three desktop viewports are free of incoherent overlap and horizontal page
  overflow.
- Chart rendering does not require an external CDN.
- Existing calculator and backtest workflows remain functional.
- Automated tests, browser smoke checks, and console checks pass.
