# Open Interest Alignment Design

Date: 2026-07-16

## Goal

Make the `openInterest` factor reflect real Binance open-interest participation instead of reusing taker flow as a proxy, and keep the live factor output consistent with the backtest model.

## Scope

- Redefine `openInterest` as an OI-plus-price confirmation factor.
- Use the latest sentiment row plus recent historical OI rows to measure whether participation is rising or falling.
- Prefer `oi_value` for change detection and fall back to `open_interest` when not available.
- Share the same scoring helper between live factor generation and backtest scoring.
- Add automated tests for bullish confirmation, bearish confirmation, OI decline, and insufficient-history fallback.

## Non-Goals

- No change to the `takerVol` factor logic or weight.
- No new upstream data source or database schema change.
- No redesign of other factor thresholds unless required to keep this factor internally consistent.

## Scoring Model

- `OI up + price up` scores bullish because new participation is confirming an upward move.
- `OI up + price down` scores bearish because new participation is confirming a downward move.
- `OI down + price up` stays weakly bullish or neutral because the move is more likely driven by covering than by fresh conviction.
- `OI down + price down` stays weakly bearish or neutral for the same reason.
- If the recent OI change or recent price change is too small to be meaningful, the factor should decay toward neutral instead of forcing a directional read.

## Data Rules

- Live scoring compares the latest sentiment row with the nearest earlier usable row within the recent sentiment window.
- Backtest scoring uses the same helper against the sliced `sentimentWindow`, so historical evaluation matches live behavior.
- The helper should search backwards for a usable baseline rather than assuming the immediately previous row is valid.
- If there is not enough OI history or price history, return a neutral score and a low or zero effective weight rather than inferring direction from unrelated fields.

## Implementation Shape

- Extract reusable OI scoring helpers into `lib/factor-support.js`.
- Update the live `factorOpenInterest` path in `server.js` to call the helper and keep the existing response shape.
- Update the backtest sentiment block in `computeFactorScoreAtIndex` to call the same helper for the `openInterest` score.
- Keep detail text focused on OI scale, OI direction, and recent price direction so the UI explanation matches the new logic.

## Validation

- Unit tests cover the four core scenarios and the fallback path.
- `npm test` passes.
- `node --check server.js` passes.
- A local runtime check confirms `/api/factors` still returns the `openInterest` factor with stable payload structure after the scoring change.
