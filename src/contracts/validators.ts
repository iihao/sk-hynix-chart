import { BacktestResponse, FactorsResponse, IndicatorsResponse, QualityResponse } from './api';

function expectObject(value: unknown, field: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value as Record<string, any>;
}

function expectArray(value: unknown, field: string): any[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value;
}

function expectNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value;
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid API response: ${field}`);
  }
  return value;
}

function expectDirection(value: unknown, field: string): void {
  if (!['long', 'short', 'neutral'].includes(String(value))) {
    throw new Error(`Invalid API response: ${field}`);
  }
}

function expectFactorDrivers(value: unknown, field: string): void {
  const drivers = expectArray(value, field);
  for (const [index, driverValue] of drivers.entries()) {
    const driver = expectObject(driverValue, `${field}[${index}]`);
    expectString(driver.category, `${field}[${index}].category`);
    expectString(driver.label, `${field}[${index}].label`);
    expectNumber(driver.score, `${field}[${index}].score`);
    expectString(driver.contribution, `${field}[${index}].contribution`);
  }
}

function expectDecisionTrace(value: unknown, field: string): void {
  const trace = expectObject(value, field);
  const raw = expectObject(trace.raw, `${field}.raw`);
  expectDirection(raw.direction, `${field}.raw.direction`);
  expectNumber(raw.composite, `${field}.raw.composite`);
  expectNumber(raw.confidence, `${field}.raw.confidence`);
  expectNumber(raw.consensusPct, `${field}.raw.consensusPct`);
  expectString(raw.summary, `${field}.raw.summary`);
  expectFactorDrivers(raw.topDrivers, `${field}.raw.topDrivers`);

  const technical = expectObject(trace.technical, `${field}.technical`);
  if (!['confirm', 'diverge', 'neutral', 'unknown'].includes(String(technical.verdict))) {
    throw new Error(`Invalid API response: ${field}.technical.verdict`);
  }
  expectNumber(technical.agreementPct, `${field}.technical.agreementPct`);
  expectString(technical.summary, `${field}.technical.summary`);
  expectArray(technical.checks, `${field}.technical.checks`);

  const impact = expectObject(trace.impact, `${field}.impact`);
  if (!['supportive', 'conflicting', 'neutral'].includes(String(impact.verdict))) {
    throw new Error(`Invalid API response: ${field}.impact.verdict`);
  }
  expectString(impact.summary, `${field}.impact.summary`);
  expectFactorDrivers(impact.drivers, `${field}.impact.drivers`);

  const backtest = expectObject(trace.backtest, `${field}.backtest`);
  if (!['tradable', 'weak', 'insufficient'].includes(String(backtest.verdict))) {
    throw new Error(`Invalid API response: ${field}.backtest.verdict`);
  }
  expectNumber(backtest.probability, `${field}.backtest.probability`);
  expectNumber(backtest.sampleTrades, `${field}.backtest.sampleTrades`);
  expectNumber(backtest.winRate, `${field}.backtest.winRate`);
  expectNumber(backtest.totalReturn, `${field}.backtest.totalReturn`);
  expectNumber(backtest.maxDrawdown, `${field}.backtest.maxDrawdown`);
  expectNumber(backtest.sharpe, `${field}.backtest.sharpe`);
  expectString(backtest.summary, `${field}.backtest.summary`);

  const final = expectObject(trace.final, `${field}.final`);
  expectString(final.action, `${field}.final.action`);
  expectDirection(final.originalDirection, `${field}.final.originalDirection`);
  expectDirection(final.finalDirection, `${field}.final.finalDirection`);
  expectBoolean(final.directionOverridden, `${field}.final.directionOverridden`);
  expectString(final.overrideReason, `${field}.final.overrideReason`);
  expectNumber(final.confidence, `${field}.final.confidence`);
  expectString(final.summary, `${field}.final.summary`);
  expectArray(final.blockers, `${field}.final.blockers`);
}

function expectTimeframeProfile(value: unknown, field: string): void {
  const profile = expectObject(value, field);
  if (typeof profile.tf !== 'string') throw new Error(`Invalid API response: ${field}.tf`);
  if (typeof profile.label !== 'string') throw new Error(`Invalid API response: ${field}.label`);
  if (typeof profile.role !== 'string') throw new Error(`Invalid API response: ${field}.role`);
  expectNumber(profile.decisionWeight, `${field}.decisionWeight`);
  expectNumber(profile.minSampleTrades, `${field}.minSampleTrades`);
  expectObject(profile.params, `${field}.params`);
}

export function parseIndicatorsResponse(value: unknown): IndicatorsResponse {
  const data = expectObject(value, 'indicators');
  expectArray(data.rsi, 'rsi');
  expectArray(data.signals, 'signals');
  expectArray(data.support, 'support');
  expectArray(data.resistance, 'resistance');
  expectArray(data.times, 'times');
  if (data.latest != null) {
    const latest = expectObject(data.latest, 'latest');
    expectNumber(latest.rsi, 'latest.rsi');
    expectNumber(latest.macdHist, 'latest.macdHist');
    expectNumber(latest.volRatio, 'latest.volRatio');
  }
  return data as unknown as IndicatorsResponse;
}

export function parseFactorsResponse(value: unknown): FactorsResponse {
  const data = expectObject(value, 'factors response');
  const factors = expectArray(data.factors, 'factors');
  for (const [index, factorValue] of factors.entries()) {
    const factor = expectObject(factorValue, `factors[${index}]`);
    expectNumber(factor.score, `factors[${index}].score`);
    expectNumber(factor.weight, `factors[${index}].weight`);
    if (typeof factor.label !== 'string') {
      throw new Error(`Invalid API response: factors[${index}].label`);
    }
  }
  expectNumber(data.composite, 'composite');
  expectNumber(data.confidence, 'confidence');
  if (data.rawConfidence !== undefined) {
    expectNumber(data.rawConfidence, 'rawConfidence');
  }
  if (data.backtestCalibration !== undefined) {
    const calibration = expectObject(data.backtestCalibration, 'backtestCalibration');
    expectNumber(calibration.winRate, 'backtestCalibration.winRate');
    expectNumber(calibration.profitProbability, 'backtestCalibration.profitProbability');
    expectNumber(calibration.sampleTrades, 'backtestCalibration.sampleTrades');
    expectNumber(calibration.totalReturn, 'backtestCalibration.totalReturn');
    expectNumber(calibration.maxDrawdown, 'backtestCalibration.maxDrawdown');
    expectNumber(calibration.sharpe, 'backtestCalibration.sharpe');
    if (!['active-backtest', 'insufficient'].includes(calibration.source)) {
      throw new Error('Invalid API response: backtestCalibration.source');
    }
    if (calibration.updatedAt !== null && typeof calibration.updatedAt !== 'string') {
      throw new Error('Invalid API response: backtestCalibration.updatedAt');
    }
  }
  if (data.confidenceCalibration !== undefined) {
    const calibration = expectObject(data.confidenceCalibration, 'confidenceCalibration');
    expectNumber(calibration.rawConfidence, 'confidenceCalibration.rawConfidence');
    expectNumber(calibration.confidence, 'confidenceCalibration.confidence');
    expectNumber(calibration.backtestProbability, 'confidenceCalibration.backtestProbability');
    expectNumber(calibration.sampleTrades, 'confidenceCalibration.sampleTrades');
    expectNumber(calibration.factorAgreement, 'confidenceCalibration.factorAgreement');
    expectNumber(calibration.indicatorAgreement, 'confidenceCalibration.indicatorAgreement');
    expectArray(calibration.penalties, 'confidenceCalibration.penalties');
    if (typeof calibration.note !== 'string') {
      throw new Error('Invalid API response: confidenceCalibration.note');
    }
    if (calibration.debug !== undefined) {
      const debug = expectObject(calibration.debug, 'confidenceCalibration.debug');
      expectNumber(debug.rawScore, 'confidenceCalibration.debug.rawScore');
      expectNumber(debug.backtestScore, 'confidenceCalibration.debug.backtestScore');
      expectNumber(debug.sampleScore, 'confidenceCalibration.debug.sampleScore');
      expectNumber(debug.performanceScore, 'confidenceCalibration.debug.performanceScore');
      expectNumber(debug.drawdownScore, 'confidenceCalibration.debug.drawdownScore');
      expectNumber(debug.sharpeScore, 'confidenceCalibration.debug.sharpeScore');
      expectNumber(debug.factorScore, 'confidenceCalibration.debug.factorScore');
      expectNumber(debug.indicatorScore, 'confidenceCalibration.debug.indicatorScore');
      expectNumber(debug.signalBonus, 'confidenceCalibration.debug.signalBonus');
      expectArray(debug.penaltyDetails, 'confidenceCalibration.debug.penaltyDetails');
      expectString(debug.formula, 'confidenceCalibration.debug.formula');
    }
  }
  if (data.timeframeProfile !== undefined) {
    expectTimeframeProfile(data.timeframeProfile, 'timeframeProfile');
  }
  if (data.strategy !== undefined) {
    const strategy = expectObject(data.strategy, 'strategy');
    if (strategy.advice !== undefined) {
      const advice = expectObject(strategy.advice, 'strategy.advice');
      if (advice.decisionTrace !== undefined) {
        expectDecisionTrace(advice.decisionTrace, 'strategy.advice.decisionTrace');
      }
    }
  }
  if (!['long', 'short', 'neutral'].includes(data.direction)) {
    throw new Error('Invalid API response: direction');
  }
  return data as unknown as FactorsResponse;
}

export function parseBacktestResponse(value: unknown): BacktestResponse {
  const data = expectObject(value, 'backtest');
  if (typeof data.error === 'string') {
    expectArray(data.trades, 'trades');
    return data as unknown as BacktestResponse;
  }
  expectArray(data.trades, 'trades');
  expectArray(data.equityCurve, 'equityCurve');
  const metrics = expectObject(data.metrics, 'metrics');
  expectNumber(metrics.winRate, 'metrics.winRate');
  expectNumber(metrics.totalReturn, 'metrics.totalReturn');
  expectNumber(metrics.sharpe ?? metrics.sharpeRatio, 'metrics.sharpe');
  expectNumber(metrics.profitFactor, 'metrics.profitFactor');
  expectNumber(metrics.maxDrawdown, 'metrics.maxDrawdown');
  expectNumber(metrics.totalTrades, 'metrics.totalTrades');
  expectNumber(metrics.avgWin, 'metrics.avgWin');
  expectNumber(metrics.avgLoss, 'metrics.avgLoss');
  if (data.timeframeProfile !== undefined) {
    expectTimeframeProfile(data.timeframeProfile, 'timeframeProfile');
  }
  if (data.activeProfiles !== undefined) {
    const activeProfiles = expectObject(data.activeProfiles, 'activeProfiles');
    for (const [key, profile] of Object.entries(activeProfiles)) {
      expectTimeframeProfile(profile, `activeProfiles.${key}`);
    }
  }
  return data as unknown as BacktestResponse;
}

export function parseQualityResponse(value: unknown): QualityResponse {
  const data = expectObject(value, 'quality');
  expectNumber(data.serverTime, 'serverTime');
  if (!['healthy', 'degraded', 'unavailable'].includes(data.overall)) {
    throw new Error('Invalid API response: overall');
  }
  const collectors = expectArray(data.collectors, 'collectors');
  for (const [index, collectorValue] of collectors.entries()) {
    const collector = expectObject(collectorValue, `collectors[${index}]`);
    if (typeof collector.key !== 'string') throw new Error(`Invalid API response: collectors[${index}].key`);
    if (!['starting', 'healthy', 'degraded', 'open', 'half-open', 'stopped'].includes(collector.state)) {
      throw new Error(`Invalid API response: collectors[${index}].state`);
    }
    if (!['direct', 'proxy', 'local', 'none'].includes(collector.transport)) {
      throw new Error(`Invalid API response: collectors[${index}].transport`);
    }
  }
  const sources = expectArray(data.sources, 'sources');
  for (const [index, sourceValue] of sources.entries()) {
    const source = expectObject(sourceValue, `sources[${index}]`);
    if (typeof source.key !== 'string') throw new Error(`Invalid API response: sources[${index}].key`);
    if (!['ok', 'idle', 'stale', 'missing'].includes(source.status)) {
      throw new Error(`Invalid API response: sources[${index}].status`);
    }
    if (source.ageSec !== null) expectNumber(source.ageSec, `sources[${index}].ageSec`);
    if (typeof source.expectedActive !== 'boolean') {
      throw new Error(`Invalid API response: sources[${index}].expectedActive`);
    }
    if (typeof source.detail !== 'string') throw new Error(`Invalid API response: sources[${index}].detail`);
  }
  return data as unknown as QualityResponse;
}
