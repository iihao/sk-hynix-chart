import { BacktestCalibration, buildBacktestCalibration } from './calibration';

export type TimeframeKey = 'm1' | 'm5' | 'm15' | 'h1';
export type TimeframeRole = 'scalp' | 'trade' | 'confirm';

export interface TimeframeBacktestParams {
  entryThreshold: number;
  holdBars: number;
  stopLossPct: number;
  takeProfitPct: number;
  leverage: number;
}

export interface TimeframeProfile {
  tf: TimeframeKey;
  label: string;
  role: TimeframeRole;
  decisionWeight: number;
  entryThresholdMultiplier: number;
  minSampleTrades: number;
  technicalWeight: number;
  factorWeight: number;
  backtestWeight: number;
  defaultParams: TimeframeBacktestParams;
  thresholdCandidates: number[];
  holdBarsCandidates: number[];
  weightMultipliers: Record<string, number>;
}

export interface TimeframeState {
  profile: TimeframeProfile;
  weights: Record<string, number>;
  params: TimeframeBacktestParams;
  calibration: BacktestCalibration;
  optimizeTime: number;
}

const PROFILE_ORDER: TimeframeKey[] = ['m1', 'm5', 'm15', 'h1'];

export const TIMEFRAME_PROFILES: Record<TimeframeKey, TimeframeProfile> = {
  m1: {
    tf: 'm1',
    label: '1m 入场节奏',
    role: 'scalp',
    decisionWeight: 0.2,
    entryThresholdMultiplier: 1.25,
    minSampleTrades: 30,
    technicalWeight: 0.35,
    factorWeight: 0.45,
    backtestWeight: 0.2,
    defaultParams: { entryThreshold: 0.65, holdBars: 8, stopLossPct: 1.2, takeProfitPct: 2.2, leverage: 5 },
    thresholdCandidates: [0.65, 0.8, 1.0, 1.25],
    holdBarsCandidates: [5, 8, 12, 16],
    weightMultipliers: {
      momentum: 1.15,
      indicator: 1.15,
      premium: 0.9,
      volume: 1.1,
      volatility: 1.2,
      news: 0.7,
      fx: 0.8,
    },
  },
  m5: {
    tf: 'm5',
    label: '5m 主决策',
    role: 'trade',
    decisionWeight: 0.45,
    entryThresholdMultiplier: 1,
    minSampleTrades: 20,
    technicalWeight: 0.3,
    factorWeight: 0.45,
    backtestWeight: 0.25,
    defaultParams: { entryThreshold: 0.5, holdBars: 12, stopLossPct: 3, takeProfitPct: 5, leverage: 5 },
    thresholdCandidates: [0.5, 0.8, 1.2, 1.6],
    holdBarsCandidates: [8, 12, 18, 24],
    weightMultipliers: {},
  },
  m15: {
    tf: 'm15',
    label: '15m 趋势确认',
    role: 'confirm',
    decisionWeight: 0.25,
    entryThresholdMultiplier: 1.05,
    minSampleTrades: 12,
    technicalWeight: 0.36,
    factorWeight: 0.39,
    backtestWeight: 0.25,
    defaultParams: { entryThreshold: 0.6, holdBars: 10, stopLossPct: 3.8, takeProfitPct: 6.5, leverage: 4 },
    thresholdCandidates: [0.6, 0.9, 1.2, 1.7],
    holdBarsCandidates: [6, 10, 14, 20],
    weightMultipliers: {
      momentum: 1.05,
      indicator: 1.2,
      structure: 1.15,
      volume: 0.85,
      takerVol: 0.85,
    },
  },
  h1: {
    tf: 'h1',
    label: '1h 大方向过滤',
    role: 'confirm',
    decisionWeight: 0.1,
    entryThresholdMultiplier: 1.1,
    minSampleTrades: 8,
    technicalWeight: 0.4,
    factorWeight: 0.35,
    backtestWeight: 0.25,
    defaultParams: { entryThreshold: 0.7, holdBars: 8, stopLossPct: 5, takeProfitPct: 9, leverage: 3 },
    thresholdCandidates: [0.7, 1.0, 1.4, 1.8],
    holdBarsCandidates: [4, 8, 12, 16],
    weightMultipliers: {
      momentum: 1.15,
      indicator: 1.25,
      structure: 1.2,
      funding: 0.85,
      takerVol: 0.75,
      whale: 0.8,
    },
  },
};

export function normalizeProfileTimeframe(tf: string | undefined | null): TimeframeKey {
  const normalized = String(tf || '').trim();
  if (normalized === '1m') return 'm1';
  if (normalized === '5m') return 'm5';
  if (normalized === '15m') return 'm15';
  if (normalized === '1h') return 'h1';
  if (normalized === 'm1' || normalized === 'm5' || normalized === 'm15' || normalized === 'h1') {
    return normalized;
  }
  return 'm5';
}

export function listTimeframeProfiles(): TimeframeProfile[] {
  return PROFILE_ORDER.map((tf) => TIMEFRAME_PROFILES[tf]);
}

export function getTimeframeProfile(tf: string | undefined | null): TimeframeProfile {
  return TIMEFRAME_PROFILES[normalizeProfileTimeframe(tf)];
}

export function applyTimeframeWeightMultipliers(
  baseWeights: Record<string, number>,
  profile: TimeframeProfile,
): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const [key, value] of Object.entries(baseWeights)) {
    const multiplier = profile.weightMultipliers[key] ?? 1;
    weights[key] = Math.round(Math.max(0, value * multiplier) * 100) / 100;
  }
  return weights;
}

export function createInitialTimeframeStates(baseWeights: Record<string, number>): Record<TimeframeKey, TimeframeState> {
  return Object.fromEntries(PROFILE_ORDER.map((tf) => {
    const profile = TIMEFRAME_PROFILES[tf];
    return [tf, {
      profile,
      weights: applyTimeframeWeightMultipliers(baseWeights, profile),
      params: { ...profile.defaultParams },
      calibration: buildBacktestCalibration(null),
      optimizeTime: 0,
    }];
  })) as Record<TimeframeKey, TimeframeState>;
}

export function summarizeTimeframeState(state: TimeframeState) {
  return {
    tf: state.profile.tf,
    label: state.profile.label,
    role: state.profile.role,
    decisionWeight: state.profile.decisionWeight,
    minSampleTrades: state.profile.minSampleTrades,
    params: { ...state.params },
    calibration: state.calibration,
    optimizeTime: state.optimizeTime ? new Date(state.optimizeTime).toISOString() : null,
  };
}
