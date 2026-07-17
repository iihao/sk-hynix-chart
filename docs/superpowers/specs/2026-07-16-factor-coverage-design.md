# Factor Coverage Design

Date: 2026-07-16

## Goal

Repair the currently missing news factor, backfill Binance sentiment history using source timestamps, and expose factor coverage plus source freshness to the UI without changing the scoring model.

## Scope

- Fix news ingestion by parsing Google News RSS instead of treating it as JSON.
- Persist hourly Binance sentiment history from all four upstream feeds.
- Add `coverage` and `sourceHealth` fields to `/api/factors`.
- Show a compact coverage summary beneath the factor tags in the existing UI.

## Non-Goals

- No changes to factor scoring thresholds or weights.
- No redesign of the dashboard layout.
- No backtest model changes in this pass.

## Validation

- Automated tests cover RSS parsing, sentiment history merging, and coverage summarization.
- Local API responses show the new payload fields.
- The dashboard renders coverage, missing factors, and source freshness without breaking current factor tags.
