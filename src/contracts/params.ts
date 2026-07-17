export interface BacktestRequestParams {
  entryThreshold: number;
  holdBars: number;
  stopLossPct: number;
  takeProfitPct: number;
  leverage: number;
}

type QueryParams = Record<string, unknown>;

interface NumericParam {
  name: keyof BacktestRequestParams;
  min: number;
  max: number;
  integer?: boolean;
}

const PARAMS: NumericParam[] = [
  { name: 'entryThreshold', min: 0.5, max: 8 },
  { name: 'holdBars', min: 3, max: 500, integer: true },
  { name: 'stopLossPct', min: 0.1, max: 50 },
  { name: 'takeProfitPct', min: 0.1, max: 100 },
  { name: 'leverage', min: 1, max: 20, integer: true },
];

function invalidParam(name: string): never {
  throw new Error(`INVALID_BACKTEST_PARAMS: ${name}`);
}

function parseNumericParam(value: unknown, config: NumericParam, defaultValue: number): number {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    return defaultValue;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return invalidParam(config.name);
  }

  const parsed = Number(value);
  if (
    !Number.isFinite(parsed)
    || parsed < config.min
    || parsed > config.max
    || (config.integer && !Number.isInteger(parsed))
  ) {
    return invalidParam(config.name);
  }
  return parsed;
}

export function parseBacktestParams(
  query: QueryParams,
  defaults: BacktestRequestParams,
): BacktestRequestParams {
  const parsed = {} as BacktestRequestParams;
  for (const config of PARAMS) {
    parsed[config.name] = parseNumericParam(
      query[config.name],
      config,
      defaults[config.name],
    );
  }
  return parsed;
}
