export interface DashboardSnapshot {
  m1: unknown;
  m5: unknown;
  m15: unknown;
  h1: unknown;
  source: string;
  krwUsd: number;
  serverTime: number;
  binance: unknown;
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isCompleteDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!isObject(value)) return false;
  return ['m1', 'm5', 'm15', 'h1'].every((key) => isObject(value[key]))
    && typeof value.source === 'string'
    && value.source.length > 0
    && typeof value.krwUsd === 'number'
    && Number.isFinite(value.krwUsd)
    && typeof value.serverTime === 'number'
    && Number.isFinite(value.serverTime);
}

export function mergeBinanceIntoSnapshot(
  previous: unknown,
  binance: unknown,
  serverTime: number,
): DashboardSnapshot {
  if (!isCompleteDashboardSnapshot(previous)) {
    throw new Error('INCOMPLETE_DASHBOARD_SNAPSHOT');
  }
  if (!Number.isFinite(serverTime)) {
    throw new Error('INVALID_STREAM_TIMESTAMP');
  }
  return {
    ...previous,
    binance,
    serverTime,
  };
}
