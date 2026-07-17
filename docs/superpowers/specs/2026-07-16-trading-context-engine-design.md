# Trading Context Engine Design

Date: 2026-07-16

## Goal

Add a shared trading-context layer that makes market hours, funding timing, earnings freeze windows, basis dislocations, risk limits, and regime state visible in the UI and usable by the live decision engine.

## Scope

- Add a market context engine for KRX session state, after-hours state, Binance funding countdown, and event freeze windows.
- Add a basis engine for KRW spot converted to USD versus `SKHYNIXUSDT`, including basis %, rolling z-score, and deviation bands.
- Add a risk engine that recommends position size and can block or reduce new trades based on ATR, volatility, basis stress, funding cost, and event risk.
- Add a regime state machine with `trend`, `range`, and `event` modes that influences live strategy thresholds and messaging.
- Surface the new outputs through `/api/factors` and the existing UI.

## Non-Goals

- No new third-party data source beyond the feeds already in use.
- No full holiday calendar or exchange-exception calendar in this pass.
- No full historical event replay engine in backtests for this pass.
- No order execution or broker integration.

## Architecture

- Create a focused helper module for trading context logic instead of adding more branching to `server.js`.
- Keep factor scoring intact, but let strategy generation consume the new context layer to adjust confidence, direction, leverage, and warnings.
- Treat basis and event stress as risk overlays rather than as another directional alpha factor.

## Decision Rules

- `event` mode has highest priority and can force observation or reduced size inside the earnings freeze window.
- `trend` mode applies when factor consensus and composite strength are aligned without major basis stress.
- `range` mode applies when composite is near neutral or directional evidence is mixed.
- Extreme basis z-scores reduce confidence and can block chasing mapped-price divergence.
- Direction-sensitive funding cost can block new longs when positive funding is too expensive or block new shorts when negative funding is too expensive.

## Validation

- Automated tests cover session state, event freeze windows, basis z-score snapshots, risk blocking, and regime selection.
- `npm test` passes.
- `node --check server.js` passes.
- A live `/api/factors` response contains `marketContext`, `basis`, `risk`, and `regime`.
