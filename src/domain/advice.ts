// src/domain/advice.ts
// 新手友好的操作建议生成模块
// 核心原则: 因子驱动 → 简单语言 → 可追溯

import { Factor } from './factors';
import type { BacktestCalibration, SignalConfidenceCalibration } from './calibration';

// ─── 新手友好接口 ────────────────────────────────

export interface OperationAdvice {
  /** 一句话操作: "做多" / "做空" / "观望不动" */
  action: string;
  /** 信号强度: "强" / "中" / "弱" / "无" */
  signalStrength: string;
  /** 信心分 0-100 */
  confidence: number;
  /** 核心理由 (一句话, 给小白看的) */
  reason: string;
  /** 入场建议 */
  entry: EntryAdvice;
  /** 出场建议 (止盈止损) */
  exit: ExitAdvice;
  /** 仓位建议 */
  position: PositionAdvice;
  /** 风险警告 */
  warnings: string[];
  /** 驱动因子归因 (可选, 给进阶用户看) */
  drivers?: FactorDriver[];
  /** 原始因子、技术确认、影响因子、回测和最终建议的完整决策链路 */
  decisionTrace: DecisionTrace;
}

export interface DecisionTrace {
  raw: {
    direction: 'long' | 'short' | 'neutral';
    composite: number;
    confidence: number;
    consensusPct: number;
    summary: string;
    topDrivers: FactorDriver[];
  };
  technical: {
    verdict: 'confirm' | 'diverge' | 'neutral' | 'unknown';
    agreementPct: number;
    summary: string;
    checks: string[];
  };
  impact: {
    verdict: 'supportive' | 'conflicting' | 'neutral';
    summary: string;
    drivers: FactorDriver[];
  };
  backtest: {
    verdict: 'tradable' | 'weak' | 'insufficient';
    probability: number;
    sampleTrades: number;
    winRate: number;
    totalReturn: number;
    maxDrawdown: number;
    sharpe: number;
    summary: string;
  };
  final: {
    action: string;
    originalDirection: 'long' | 'short' | 'neutral';
    finalDirection: 'long' | 'short' | 'neutral';
    directionOverridden: boolean;
    overrideReason: string;
    confidence: number;
    summary: string;
    blockers: string[];
  };
}

export interface EntryAdvice {
  /** 入场方式描述 */
  text: string;
  /** 具体价位 (0 表示当前价附近) */
  price: number;
  /** 入场条件 (如果需要等待) */
  condition?: string;
}

export interface ExitAdvice {
  /** 止盈描述 */
  takeProfit: string;
  /** 止盈价 */
  takeProfitPrice: number;
  /** 止损描述 */
  stopLoss: string;
  /** 止损价 */
  stopLossPrice: number;
  /** 盈亏比 */
  riskReward: string;
}

export interface PositionAdvice {
  /** 仓位百分比 0-100 */
  pct: number;
  /** 杠杆建议 */
  leverage: string;
  /** 仓位描述 */
  text: string;
}

export interface FactorDriver {
  category: string;
  label: string;
  score: number;
  /** 这个因子对建议的贡献描述 */
  contribution: string;
}

// ─── 因子模式识别 ────────────────────────────────

interface FactorPattern {
  name: string;
  /** 主导因子 */
  dominant: string;
  /** 判断逻辑 */
  match: (factors: Factor[]) => boolean;
  /** 生成建议 */
  advise: (ctx: AdviceContext) => OperationAdvice;
}

export interface AdviceContext {
  factors: Factor[];
  composite: number;
  direction: 'long' | 'short' | 'neutral';
  confidence: number;
  currentPrice: number;
  atrPct: number;
  atrValue: number;
  consensus: number;
  regime: 'trend' | 'range' | 'event';
  /** 支撑位列表 (从近到远) */
  supportPrices: number[];
  /** 阻力位列表 (从近到远) */
  resistancePrices: number[];
  ma20: number;
  rsi: number;
  fundingRate: number;
  eventStatus: string;
  basisZScore: number;
  backtestCalibration?: BacktestCalibration;
  confidenceCalibration?: SignalConfidenceCalibration;
}

// ─── 工具函数 ──────────────────────────────────

function round0(v: number): number {
  return Math.round(v);
}

function pct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function confidenceLabel(c: number): string {
  if (c >= 75) return '强';
  if (c >= 50) return '中';
  if (c >= 25) return '弱';
  return '无';
}

function directionAction(d: 'long' | 'short' | 'neutral'): string {
  if (d === 'long') return '做多';
  if (d === 'short') return '做空';
  return '观望不动';
}

function directionLabel(d: 'long' | 'short' | 'neutral'): string {
  if (d === 'long') return '偏多';
  if (d === 'short') return '偏空';
  return '中性';
}

/** 从因子列表中找到指定 category */
function findFactor(factors: Factor[], category: string): Factor | undefined {
  return factors.find(f => f.category === category);
}

/** 找到得分绝对值最大的因子作为主导因子 */
function dominantFactor(factors: Factor[]): Factor | null {
  if (!factors.length) return null;
  return factors.reduce((best, f) =>
    Math.abs(f.score) > Math.abs(best.score) ? f : best, factors[0]);
}

/** 找到得分绝对值最大的 N 个因子 */
function topFactors(factors: Factor[], n: number): Factor[] {
  return [...factors].sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, n);
}

// ─── 入场/出场计算 (因子驱动) ──────────────────────

function calcEntryForPattern(
  pattern: string,
  ctx: AdviceContext,
): EntryAdvice {
  const p = ctx.currentPrice;
  const ma = ctx.ma20;
  const sup0 = ctx.supportPrices[0] || 0;
  const res0 = ctx.resistancePrices[0] || 0;

  switch (pattern) {
    // 庄家主导: 跟庄, 回踩均线入场
    case 'whale-long':
      if (p > ma) return { text: `等价格回落到 ${round0(ma)} 附近再买`, price: ma, condition: '回踩均线' };
      return { text: `当前价 ${round0(p)} 可以入场`, price: p };

    case 'whale-short':
      if (p < ma) return { text: `等价格反弹到 ${round0(ma)} 附近再卖`, price: ma, condition: '反弹均线' };
      return { text: `当前价 ${round0(p)} 可以入场`, price: p };

    // 溢价主导: 等基差回归
    case 'premium-high':
      return { text: `合约溢价偏高, 等回落到 ${round0(p * 0.98)} 再考虑`, price: round0(p * 0.98), condition: '溢价收敛' };

    case 'premium-low':
      return { text: `合约折价, 当前价 ${round0(p)} 可以入场`, price: p };

    // 趋势主导: 顺势入场
    case 'trend-long':
      if (sup0 > 0 && (p - sup0) / p < 0.03) {
        return { text: `价格接近支撑位 ${round0(sup0)}, 可以入场`, price: sup0, condition: '支撑位确认' };
      }
      return { text: `当前价 ${round0(p)} 趋势向上, 可以入场`, price: p };

    case 'trend-short':
      if (res0 > 0 && (res0 - p) / p < 0.03) {
        return { text: `价格接近阻力位 ${round0(res0)}, 可以做空`, price: res0, condition: '阻力位确认' };
      }
      return { text: `当前价 ${round0(p)} 趋势向下, 可以做空`, price: p };

    // 反转主导: 超卖/超买
    case 'reversal-long':
      if (sup0 > 0) return { text: `价格在支撑位 ${round0(sup0)} 附近, 可以抄底`, price: sup0 };
      return { text: `超卖反弹, 当前价 ${round0(p)} 可以入场`, price: p };

    case 'reversal-short':
      if (res0 > 0) return { text: `价格在阻力位 ${round0(res0)} 附近, 可以做空`, price: res0 };
      return { text: `超买回落, 当前价 ${round0(p)} 可以做空`, price: p };

    // 默认: 观望
    default:
      return { text: '信号不明确, 不建议入场', price: 0 };
  }
}

function calcExitForPattern(
  direction: 'long' | 'short' | 'neutral',
  ctx: AdviceContext,
  patternConfidence: number,
): ExitAdvice {
  const p = ctx.currentPrice;
  const atr = ctx.atrValue;

  if (direction === 'neutral') {
    return {
      takeProfit: '—',
      takeProfitPrice: 0,
      stopLoss: '—',
      stopLossPrice: 0,
      riskReward: '—',
    };
  }

  // 信心越高, 止盈越远; 信心越低, 止盈越近
  const tpMultiplier = patternConfidence >= 70 ? 4 : patternConfidence >= 45 ? 3 : 2;
  const slMultiplier = 2;

  const tpOffset = atr * tpMultiplier;
  const slOffset = atr * slMultiplier;

  let tpPrice: number;
  let slPrice: number;
  let rr: string;

  if (direction === 'long') {
    tpPrice = round0(p + tpOffset);
    slPrice = round0(p - slOffset);
    rr = `1:${(tpMultiplier / slMultiplier).toFixed(1)}`;
  } else {
    tpPrice = round0(p - tpOffset);
    slPrice = round0(p + slOffset);
    rr = `1:${(tpMultiplier / slMultiplier).toFixed(1)}`;
  }

  return {
    takeProfit: `涨到 ${tpPrice} 止盈`,
    takeProfitPrice: tpPrice,
    stopLoss: `跌到 ${slPrice} 止损`,
    stopLossPrice: slPrice,
    riskReward: rr,
  };
}

// ─── 仓位计算 (因子驱动) ──────────────────────────

function calcPosition(ctx: AdviceContext, direction: 'long' | 'short' | 'neutral'): PositionAdvice {
  if (direction === 'neutral') {
    return { pct: 0, leverage: '1x', text: '不建议开仓' };
  }

  // 基础仓位由 regime 决定
  let basePct = ctx.regime === 'trend' ? 60 : ctx.regime === 'event' ? 20 : 40;

  // 波动率调整
  if (ctx.atrPct >= 3) basePct *= 0.35;
  else if (ctx.atrPct >= 2) basePct *= 0.5;
  else if (ctx.atrPct >= 1) basePct *= 0.7;

  // 基差极端偏离
  if (Math.abs(ctx.basisZScore) >= 3) basePct *= 0.25;
  else if (Math.abs(ctx.basisZScore) >= 2) basePct *= 0.5;

  // 事件窗口
  if (ctx.eventStatus === 'watch') basePct *= 0.5;
  else if (ctx.eventStatus === 'cooldown') basePct *= 0.6;
  else if (ctx.eventStatus === 'freeze') basePct = 0;

  // 共识度调整
  if (ctx.consensus >= 0.7) basePct *= 1.1;
  else if (ctx.consensus < 0.5) basePct *= 0.7;

  basePct = Math.max(0, Math.min(100, Math.round(basePct)));

  // 杠杆建议
  let leverage: string;
  if (basePct === 0) leverage = '0x';
  else if (ctx.regime === 'trend' && ctx.atrPct < 2) leverage = '5x';
  else if (ctx.atrPct < 2.5) leverage = '3x';
  else leverage = '2x';

  // 仓位描述
  let text: string;
  if (basePct === 0) text = '不建议开仓';
  else if (basePct <= 20) text = '轻仓试探';
  else if (basePct <= 40) text = '小仓位操作';
  else if (basePct <= 60) text = '正常仓位';
  else text = '可以重仓';

  return { pct: basePct, leverage, text };
}

// ─── 风险警告生成 ──────────────────────────────

function buildWarnings(ctx: AdviceContext): string[] {
  const warnings: string[] = [];

  if (ctx.atrPct > 3) warnings.push('当前波动很大, 新手建议观望');
  else if (ctx.atrPct > 2) warnings.push('波动偏高, 注意控制仓位');

  if (Math.abs(ctx.basisZScore) > 2) warnings.push('合约和现货价差异常, 小心追高');

  if (ctx.eventStatus === 'freeze') warnings.push('财报期间, 禁止开仓');
  else if (ctx.eventStatus === 'watch') warnings.push('财报临近, 建议减仓');
  else if (ctx.eventStatus === 'cooldown') warnings.push('财报刚结束, 波动可能很大');

  if (ctx.fundingRate > 0.003) warnings.push('做多资金费率很高, 持仓成本大');
  else if (ctx.fundingRate < -0.003) warnings.push('做空资金费率很高, 持仓成本大');

  if (ctx.rsi > 75) warnings.push('RSI 超买, 随时可能回调');
  else if (ctx.rsi < 25) warnings.push('RSI 超卖, 随时可能反弹');

  return warnings;
}

// ─── 因子归因 ──────────────────────────────────

function buildDrivers(factors: Factor[]): FactorDriver[] {
  const labelMap: Record<string, string> = {
    momentum: '价格动量',
    funding: '资金费率',
    volume: '成交量',
    volatility: '波动率',
    fx: '汇率',
    premium: '合约溢价',
    indicator: '技术指标',
    structure: '支撑阻力',
    lsRatio: '多空比',
    takerVol: '主动买卖',
    openInterest: '持仓量变化',
    lsTrend: '多空趋势',
    whale: '大户动向',
    news: '新闻情绪',
  };

  const contributionMap: Record<string, (score: number) => string> = {
    momentum: s => s > 0 ? '价格上涨趋势明显' : '价格下跌趋势明显',
    funding: s => s > 0 ? '资金费率对做空有利' : '资金费率对做多有利',
    volume: s => s > 0 ? '成交量放大, 趋势可信度高' : '成交量萎缩, 趋势可能不持续',
    volatility: s => s > 0 ? '波动率低, 适合入场' : '波动率高, 风险较大',
    fx: s => s > 0 ? '韩元贬值, 利好出口' : '韩元升值, 利空出口',
    premium: s => s > 0 ? '合约溢价偏高' : '合约折价',
    indicator: s => s > 0 ? 'RSI/MACD 看涨' : 'RSI/MACD 看跌',
    structure: s => s > 0 ? '接近支撑位' : '接近阻力位',
    lsRatio: s => s > 0 ? '散户看空, 可能反弹' : '散户看多, 可能回调',
    takerVol: s => s > 0 ? '主动买入多于卖出' : '主动卖出多于买入',
    openInterest: s => s > 0 ? '持仓增加, 趋势延续' : '持仓减少, 趋势减弱',
    lsTrend: s => s > 0 ? '空头在减少' : '多头在减少',
    whale: s => s > 0 ? '大户在加仓做多' : '大户在减仓/做空',
    news: s => s > 0 ? '新闻面偏正面' : '新闻面偏负面',
  };

  return topFactors(factors, 5).map(f => ({
    category: f.category,
    label: labelMap[f.category] || f.label,
    score: f.score,
    contribution: (contributionMap[f.category] || (() => f.detail))(f.score),
  }));
}

function buildTechnicalChecks(ctx: AdviceContext): string[] {
  const checks: string[] = [];
  const sign = ctx.direction === 'long' ? 1 : ctx.direction === 'short' ? -1 : 0;
  if (sign === 0) {
    checks.push('原始方向为中性，技术指标只作为等待确认参考');
  } else {
    checks.push(`价格 ${ctx.currentPrice >= ctx.ma20 ? '高于' : '低于'} MA20(${round0(ctx.ma20)})`);
  }
  checks.push(`RSI ${ctx.rsi.toFixed(1)}：${ctx.rsi > 70 ? '超买，警惕回落' : ctx.rsi < 30 ? '超卖，警惕反弹' : '未处极端区间'}`);
  checks.push(`波动率 ATR ${ctx.atrPct.toFixed(2)}%：${ctx.atrPct >= 3 ? '高波动，仓位需收缩' : '可控'}`);
  return checks;
}

function buildDecisionTrace(
  ctx: AdviceContext,
  pattern: PatternResult,
  finalDirection: 'long' | 'short' | 'neutral',
  finalConfidence: number,
  action: string,
  warnings: string[],
  drivers: FactorDriver[],
): DecisionTrace {
  const rawTopDrivers = drivers.slice(0, 3);
  const calibration = ctx.confidenceCalibration;
  const indicatorAgreement = calibration?.indicatorAgreement ?? 0;
  const agreementPct = Math.round(indicatorAgreement * 100);
  const technicalVerdict: DecisionTrace['technical']['verdict'] = ctx.direction === 'neutral'
    ? 'neutral'
    : !calibration
      ? 'unknown'
      : indicatorAgreement >= 0.55
        ? 'confirm'
        : indicatorAgreement < 0.35
          ? 'diverge'
          : 'neutral';

  const impactCategories = new Set(['premium', 'funding', 'fx', 'lsRatio', 'takerVol', 'openInterest', 'lsTrend', 'whale', 'news']);
  const impactDrivers = drivers.filter(d => impactCategories.has(d.category));
  const impactScore = ctx.factors
    .filter(f => impactCategories.has(f.category))
    .reduce((sum, f) => sum + f.score * (f.weight || 1), 0);
  const finalSign = finalDirection === 'long' ? 1 : finalDirection === 'short' ? -1 : 0;
  const impactVerdict: DecisionTrace['impact']['verdict'] = finalSign === 0 || Math.abs(impactScore) < 0.5
    ? 'neutral'
    : impactScore * finalSign > 0
      ? 'supportive'
      : 'conflicting';

  const bt = ctx.backtestCalibration;
  const backtestVerdict: DecisionTrace['backtest']['verdict'] = !bt || bt.sampleTrades < 5
    ? 'insufficient'
    : bt.profitProbability >= 51 && bt.totalReturn >= 0 && bt.maxDrawdown < 15
      ? 'tradable'
      : 'weak';
  const backtestSummary = bt
    ? `回测概率${bt.profitProbability.toFixed(1)}%，样本${bt.sampleTrades}笔，收益${pct(bt.totalReturn)}，回撤${bt.maxDrawdown.toFixed(1)}%`
    : '暂未接入有效回测样本，置信度按中性处理';

  const directionOverridden = finalDirection !== ctx.direction;
  const blockers: string[] = [];
  if (ctx.eventStatus === 'freeze') blockers.push('事件冻结窗口');
  if (ctx.atrPct >= 3) blockers.push('ATR 高波动');
  if (Math.abs(ctx.basisZScore) >= 3) blockers.push('基差极端偏离');
  if (calibration?.penalties?.length) blockers.push(`置信度惩罚：${calibration.penalties.join(', ')}`);

  return {
    raw: {
      direction: ctx.direction,
      composite: Math.round(ctx.composite * 10) / 10,
      confidence: Math.round(ctx.confidence),
      consensusPct: Math.round(ctx.consensus * 100),
      summary: `原始因子综合分 ${ctx.composite.toFixed(1)}，方向${directionLabel(ctx.direction)}，因子共识${Math.round(ctx.consensus * 100)}%。`,
      topDrivers: rawTopDrivers,
    },
    technical: {
      verdict: technicalVerdict,
      agreementPct,
      summary: calibration
        ? `技术确认度 ${agreementPct}%，用于校准置信度，不单独覆盖方向。`
        : '缺少技术校准明细，仅展示 MA/RSI/ATR 状态。',
      checks: buildTechnicalChecks(ctx),
    },
    impact: {
      verdict: impactVerdict,
      summary: impactDrivers.length
        ? `影响因子对最终方向${impactVerdict === 'supportive' ? '形成支持' : impactVerdict === 'conflicting' ? '存在冲突' : '整体中性'}。`
        : '暂无可用影响因子，主要依赖价格和技术链路。',
      drivers: impactDrivers,
    },
    backtest: {
      verdict: backtestVerdict,
      probability: bt?.profitProbability ?? calibration?.backtestProbability ?? 50,
      sampleTrades: bt?.sampleTrades ?? calibration?.sampleTrades ?? 0,
      winRate: bt?.winRate ?? 0,
      totalReturn: bt?.totalReturn ?? 0,
      maxDrawdown: bt?.maxDrawdown ?? 0,
      sharpe: bt?.sharpe ?? 0,
      summary: backtestSummary,
    },
    final: {
      action,
      originalDirection: ctx.direction,
      finalDirection,
      directionOverridden,
      overrideReason: directionOverridden ? pattern.reason : '',
      confidence: Math.round(finalConfidence),
      summary: `${action}｜${pattern.reason}｜置信度 ${Math.round(finalConfidence)}%${warnings.length ? `｜风险：${warnings[0]}` : ''}`,
      blockers,
    },
  };
}

// ─── 主导因子模式识别 + 建议生成 ──────────────────

interface PatternResult {
  pattern: string;
  reason: string;
  overrideDirection?: 'long' | 'short' | 'neutral';
  overrideConfidence?: number;
}

function identifyPattern(factors: Factor[], ctx: AdviceContext): PatternResult {
  const whale = findFactor(factors, 'whale');
  const premium = findFactor(factors, 'premium');
  const indicator = findFactor(factors, 'indicator');
  const structure = findFactor(factors, 'structure');
  const momentum = findFactor(factors, 'momentum');
  const lsRatio = findFactor(factors, 'lsRatio');
  const lsTrend = findFactor(factors, 'lsTrend');
  const takerVol = findFactor(factors, 'takerVol');
  const oi = findFactor(factors, 'openInterest');

  // ── 模式 1: 庄家高度集中 ──
  if (whale && Math.abs(whale.score) >= 3) {
    if (whale.score > 0) {
      return { pattern: 'whale-long', reason: '大户持续加仓做多, 跟庄入场' };
    } else {
      return { pattern: 'whale-short', reason: '大户在减仓或做空, 跟庄做空' };
    }
  }

  // ── 模式 2: 溢价极端 ──
  if (premium && Math.abs(premium.score) >= 3) {
    if (premium.score > 0) {
      return { pattern: 'premium-high', reason: '合约价格比现货贵很多(溢价高), 价格会回落', overrideDirection: 'short' };
    } else {
      return { pattern: 'premium-low', reason: '合约价格比现货便宜(折价), 价格会反弹', overrideDirection: 'long' };
    }
  }

  // ── 模式 3: 趋势确立 (多因子共振) ──
  const bullishCount = [momentum, indicator, takerVol, oi, lsTrend]
    .filter(f => f && f.score > 1).length;
  const bearishCount = [momentum, indicator, takerVol, oi, lsTrend]
    .filter(f => f && f.score < -1).length;

  if (ctx.consensus >= 0.6 && ctx.direction === 'long' && bullishCount >= 3) {
    return { pattern: 'trend-long', reason: '多个信号同时看涨, 趋势明确' };
  }
  if (ctx.consensus >= 0.6 && ctx.direction === 'short' && bearishCount >= 3) {
    return { pattern: 'trend-short', reason: '多个信号同时看跌, 趋势明确' };
  }

  // ── 模式 4: 超卖/超买反转 ──
  if (ctx.rsi < 30) {
    return {
      pattern: 'reversal-long',
      reason: 'RSI 超卖, 可能反弹',
      overrideDirection: 'long',
      overrideConfidence: 55,
    };
  }
  if (ctx.rsi > 70) {
    return {
      pattern: 'reversal-short',
      reason: 'RSI 超买, 可能回落',
      overrideDirection: 'short',
      overrideConfidence: 55,
    };
  }

  // ── 模式 5: 散户反向 ──
  if (lsRatio && Math.abs(lsRatio.score) >= 3) {
    if (lsRatio.score > 0) {
      return { pattern: 'reversal-long', reason: '散户过度看空, 可能反弹', overrideDirection: 'long' };
    } else {
      return { pattern: 'reversal-short', reason: '散户过度看多, 可能回调', overrideDirection: 'short' };
    }
  }

  // ── 默认: 无明确信号 ──
  return { pattern: 'none', reason: '没有足够强的信号, 建议等待', overrideDirection: 'neutral' };
}

// ─── 主入口 ──────────────────────────────────

export function generateOperationAdvice(ctx: AdviceContext): OperationAdvice {
  const { factors } = ctx;

  if (!factors.length || ctx.currentPrice <= 0) {
    return {
      action: '观望不动',
      signalStrength: '无',
      confidence: 0,
      reason: '数据不足, 无法判断',
      entry: { text: '不建议入场', price: 0 },
      exit: { takeProfit: '—', takeProfitPrice: 0, stopLoss: '—', stopLossPrice: 0, riskReward: '—' },
      position: { pct: 0, leverage: '1x', text: '不建议开仓' },
      warnings: ['数据不足, 请等待数据加载完成'],
      drivers: [],
      decisionTrace: {
        raw: {
          direction: 'neutral',
          composite: ctx.composite,
          confidence: 0,
          consensusPct: 0,
          summary: '原始数据不足，无法形成方向。',
          topDrivers: [],
        },
        technical: {
          verdict: 'unknown',
          agreementPct: 0,
          summary: '技术指标数据不足。',
          checks: [],
        },
        impact: {
          verdict: 'neutral',
          summary: '影响因子数据不足。',
          drivers: [],
        },
        backtest: {
          verdict: 'insufficient',
          probability: 50,
          sampleTrades: 0,
          winRate: 0,
          totalReturn: 0,
          maxDrawdown: 0,
          sharpe: 0,
          summary: '无有效回测样本。',
        },
        final: {
          action: '观望不动',
          originalDirection: 'neutral',
          finalDirection: 'neutral',
          directionOverridden: false,
          overrideReason: '',
          confidence: 0,
          summary: '数据不足，等待采集完成后再判断。',
          blockers: ['数据不足'],
        },
      },
    };
  }

  // 1. 识别主导因子模式
  const pattern = identifyPattern(factors, ctx);

  // 2. 确定方向和信心
  const direction = pattern.overrideDirection || ctx.direction;
  const patternConfidence = pattern.overrideConfidence || ctx.confidence;

  // 3. 生成入场建议 (因子驱动)
  const entry = calcEntryForPattern(pattern.pattern, ctx);

  // 4. 生成出场建议 (因子驱动)
  const exit = calcExitForPattern(direction, ctx, patternConfidence);

  // 5. 生成仓位建议 (因子驱动)
  const position = calcPosition(ctx, direction);

  // 6. 生成风险警告
  const warnings = buildWarnings(ctx);

  // 7. 生成因子归因
  const drivers = buildDrivers(factors);
  const action = directionAction(direction);
  const decisionTrace = buildDecisionTrace(ctx, pattern, direction, patternConfidence, action, warnings, drivers);

  return {
    action,
    signalStrength: confidenceLabel(patternConfidence),
    confidence: Math.round(patternConfidence),
    reason: pattern.reason,
    entry,
    exit,
    position,
    warnings,
    drivers,
    decisionTrace,
  };
}
