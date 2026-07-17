const KST_OFFSET_MS = 9 * 3600000;
const FOUR_HOURS_MS = 4 * 3600000;
const DEFAULT_BASIS_BUCKET_SEC = 15 * 60;

const DEFAULT_TRADING_EVENTS = [
  {
    key: 'skhynix-fy2026-q2',
    label: 'SK hynix FY2026 Q2',
    kind: 'earnings',
    atMs: Date.parse('2026-07-29T00:00:00Z'),
    watchBeforeMs: 72 * 3600000,
    freezeBeforeMs: 24 * 3600000,
    freezeAfterMs: 6 * 3600000,
    cooldownAfterMs: 24 * 3600000,
  },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function getKstParts(nowMs = Date.now()) {
  const kst = new Date(nowMs + KST_OFFSET_MS);
  return {
    kst,
    day: kst.getUTCDay(),
    minutes: kst.getUTCHours() * 60 + kst.getUTCMinutes(),
  };
}

function formatCountdown(msLeft) {
  const totalMin = Math.max(0, Math.ceil(msLeft / 60000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function getKoreaSessionState(nowMs = Date.now()) {
  const { day, minutes } = getKstParts(nowMs);
  const weekday = day !== 0 && day !== 6;
  const regular = weekday && minutes >= 540 && minutes <= 930;
  const premarket = weekday && minutes >= 480 && minutes < 540;
  const afterhours = weekday && minutes > 930 && minutes <= 1080;

  let state = 'closed';
  let label = '休市';
  if (!weekday) {
    state = 'weekend';
    label = '周末休市';
  } else if (regular) {
    state = 'regular';
    label = '韩股常规盘';
  } else if (premarket) {
    state = 'premarket';
    label = '韩股盘前';
  } else if (afterhours) {
    state = 'afterhours';
    label = '韩股盘后';
  }

  return {
    state,
    label,
    isRegular: regular,
    isPreMarket: premarket,
    isAfterHours: afterhours,
  };
}

function inferNextFundingTimeMs(nowMs = Date.now(), intervalHours = 4) {
  const intervalMs = intervalHours * 3600000;
  const currentBoundary = Math.floor(nowMs / intervalMs) * intervalMs;
  const nextBoundary = currentBoundary + intervalMs;
  return nextBoundary > nowMs ? nextBoundary : nextBoundary + intervalMs;
}

function getFundingCountdown({ nowMs = Date.now(), nextFundingTimeMs, intervalHours = 4 } = {}) {
  const nextMs = Number.isFinite(nextFundingTimeMs) && nextFundingTimeMs > nowMs
    ? nextFundingTimeMs
    : inferNextFundingTimeMs(nowMs, intervalHours);
  const msLeft = Math.max(0, nextMs - nowMs);
  return {
    intervalHours,
    nextFundingTimeMs: nextMs,
    minutesLeft: Math.ceil(msLeft / 60000),
    label: formatCountdown(msLeft),
    isSoon: msLeft <= 60 * 60000,
  };
}

function getEventWindow(nowMs = Date.now(), events = DEFAULT_TRADING_EVENTS) {
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
  let active = null;
  let nextEvent = null;

  for (const event of sorted) {
    const watchStart = event.atMs - event.watchBeforeMs;
    const freezeStart = event.atMs - event.freezeBeforeMs;
    const freezeEnd = event.atMs + event.freezeAfterMs;
    const cooldownEnd = freezeEnd + event.cooldownAfterMs;
    const hoursToEvent = (event.atMs - nowMs) / 3600000;

    if (event.atMs >= nowMs && !nextEvent) {
      nextEvent = { key: event.key, label: event.label, atMs: event.atMs, hoursToEvent: round2(hoursToEvent) };
    }

    if (nowMs >= freezeStart && nowMs <= freezeEnd) {
      active = {
        status: 'freeze',
        label: '财报冻结区',
        event,
        hoursToEvent: round2(hoursToEvent),
        untilMs: freezeEnd,
        message: `${event.label} 财报冻结区`,
      };
      break;
    }
    if (nowMs >= watchStart && nowMs < freezeStart) {
      active = {
        status: 'watch',
        label: '事件观察区',
        event,
        hoursToEvent: round2(hoursToEvent),
        untilMs: freezeStart,
        message: `${event.label} 临近，提前减仓`,
      };
      break;
    }
    if (nowMs > freezeEnd && nowMs <= cooldownEnd) {
      active = {
        status: 'cooldown',
        label: '事件冷却区',
        event,
        hoursToEvent: round2(hoursToEvent),
        untilMs: cooldownEnd,
        message: `${event.label} 刚结束，波动仍高`,
      };
      break;
    }
  }

  if (!active) {
    return {
      status: 'clear',
      label: '无事件风险',
      event: null,
      hoursToEvent: nextEvent ? nextEvent.hoursToEvent : null,
      nextEvent,
      blockNewPositions: false,
      reduceRisk: false,
      message: nextEvent ? `${nextEvent.label} ${nextEvent.hoursToEvent}h 后` : '近期无已知事件',
    };
  }

  return {
    status: active.status,
    label: active.label,
    event: { key: active.event.key, label: active.event.label, atMs: active.event.atMs },
    hoursToEvent: active.hoursToEvent,
    nextEvent,
    untilMs: active.untilMs,
    blockNewPositions: active.status === 'freeze',
    reduceRisk: active.status === 'watch' || active.status === 'cooldown',
    message: active.message,
  };
}

function bucketLast(rows, bucketSec, priceSelector) {
  const map = new Map();
  for (const row of rows || []) {
    const ts = Number(row?.ts);
    const price = Number(priceSelector(row));
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) continue;
    const bucket = Math.floor(ts / bucketSec) * bucketSec;
    map.set(bucket, { ts: bucket, price });
  }
  return map;
}

function alignBasisSeries({ spotTicks = [], binanceTicks = [], fxRate, bucketSec = DEFAULT_BASIS_BUCKET_SEC } = {}) {
  if (!Number.isFinite(fxRate) || fxRate <= 0) return [];
  const spotMap = bucketLast(spotTicks, bucketSec, row => row.after_hours_price || row.price);
  const binanceMap = bucketLast(binanceTicks, bucketSec, row => row.price);
  const timestamps = [...spotMap.keys()].filter(ts => binanceMap.has(ts)).sort((a, b) => a - b);

  return timestamps.map(ts => {
    const spotKrw = spotMap.get(ts).price;
    const binancePrice = binanceMap.get(ts).price;
    const spotUsd = spotKrw / fxRate;
    const basisPct = spotUsd > 0 ? ((binancePrice - spotUsd) / spotUsd) * 100 : 0;
    return {
      ts,
      spotKrw,
      spotUsd,
      binancePrice,
      basisPct,
    };
  });
}

function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] || 0 };
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    numerator += dx * (values[i] - meanY);
    denominator += dx * dx;
  }
  const slope = denominator ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}

function stddev(values, mean) {
  if (!values.length) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computeBasisSnapshot(series = [], options = {}) {
  const lookback = options.lookback || 96;
  const bandWidth = options.bandWidth || 2;
  const slice = series.slice(-lookback);
  if (slice.length < 10) {
    return {
      ready: false,
      currentBasisPct: 0,
      zScore: 0,
      upperBand: 0,
      lowerBand: 0,
      fairUsd: 0,
      binancePrice: 0,
      state: 'insufficient',
      label: '基差样本不足',
    };
  }

  const values = slice.map(row => row.basisPct);
  const current = slice[slice.length - 1];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sigma = stddev(values, mean);
  const { slope, intercept } = linearRegression(values);
  const regressionValue = intercept + slope * (values.length - 1);
  const residuals = values.map((value, index) => value - (intercept + slope * index));
  const residualStd = stddev(residuals, 0);
  const zScore = sigma > 0 ? (current.basisPct - mean) / sigma : 0;
  const bandDistance = residualStd > 0 ? (current.basisPct - regressionValue) / residualStd : 0;
  const upperBand = regressionValue + residualStd * bandWidth;
  const lowerBand = regressionValue - residualStd * bandWidth;

  let state = 'normal';
  let label = '基差正常';
  if (Math.abs(zScore) >= 2.5 || Math.abs(bandDistance) >= 2.5) {
    state = 'extreme';
    label = '基差极端偏离';
  } else if (Math.abs(zScore) >= 1.5 || Math.abs(bandDistance) >= 1.5) {
    state = 'stretched';
    label = '基差偏离扩大';
  }

  return {
    ready: true,
    currentBasisPct: round2(current.basisPct),
    meanBasisPct: round2(mean),
    zScore: round2(zScore),
    regressionValue: round2(regressionValue),
    upperBand: round2(upperBand),
    lowerBand: round2(lowerBand),
    bandDistance: round2(bandDistance),
    fairUsd: round2(current.spotUsd),
    binancePrice: round2(current.binancePrice),
    state,
    label,
    slope: round2(slope),
  };
}

function deriveRegime({ composite = 0, consensus = 0, eventStatus = 'clear', basisZScore = 0, atrPct = 0 } = {}) {
  if (eventStatus === 'freeze' || eventStatus === 'watch' || eventStatus === 'cooldown') {
    return {
      mode: 'event',
      label: '事件模式',
      entryThresholdMultiplier: 1.4,
      reason: '事件窗口优先，避免方向误判',
    };
  }
  if (Math.abs(composite) >= 3 && consensus >= 0.55 && Math.abs(basisZScore) < 2.3 && atrPct < 3.5) {
    return {
      mode: 'trend',
      label: '趋势模式',
      entryThresholdMultiplier: 0.9,
      reason: '方向一致性较高，适合顺势跟随',
    };
  }
  return {
    mode: 'range',
    label: '震荡模式',
    entryThresholdMultiplier: 1.15,
    reason: '多空分歧较大，优先等待确认',
  };
}

function buildRiskOverlay({
  direction = '观望',
  atrPct = 0,
  volatilityScore = 0,
  fundingRate = 0,
  eventStatus = 'clear',
  basisZScore = 0,
  regimeMode = 'range',
} = {}) {
  const directionSign = direction.includes('做多') ? 1 : direction.includes('做空') ? -1 : 0;
  const noTrade = directionSign === 0;
  const reasons = [];
  const warnings = [];
  let positionPct = regimeMode === 'trend' ? 70 : regimeMode === 'event' ? 25 : 45;

  if (noTrade) positionPct = 0;

  if (atrPct >= 3) positionPct *= 0.35;
  else if (atrPct >= 2) positionPct *= 0.5;
  else if (atrPct >= 1) positionPct *= 0.7;

  if (volatilityScore <= -6) positionPct *= 0.6;
  else if (volatilityScore <= -3) positionPct *= 0.75;

  if (Math.abs(basisZScore) >= 3) {
    positionPct *= 0.25;
    warnings.push('基差极端偏离，避免追价');
  } else if (Math.abs(basisZScore) >= 2) {
    positionPct *= 0.5;
    warnings.push('基差偏离扩大，建议缩仓');
  }

  if (eventStatus === 'watch') {
    positionPct *= 0.5;
    warnings.push('财报临近，提前减仓');
  } else if (eventStatus === 'cooldown') {
    positionPct *= 0.6;
    warnings.push('事件后波动未稳，降低仓位');
  } else if (eventStatus === 'freeze') {
    reasons.push('财报冻结区，禁止新开仓');
    positionPct = 0;
  }

  const fundingCost = directionSign === 1 ? fundingRate : directionSign === -1 ? -fundingRate : 0;
  if (directionSign !== 0 && fundingCost >= 0.0035) {
    reasons.push('当前 funding 成本过高，禁止顺势开仓');
    positionPct = 0;
  } else if (directionSign !== 0 && fundingCost >= 0.0015) {
    positionPct *= 0.6;
    warnings.push('funding 成本偏高，降低仓位');
  }

  positionPct = clamp(Math.round(positionPct), 0, 100);
  const blocked = reasons.length > 0 && positionPct === 0;
  const maxSingleLossPct = atrPct >= 2 ? 0.35 : atrPct >= 1 ? 0.5 : 0.75;
  const maxDailyLossPct = blocked ? 0.75 : atrPct >= 2 ? 1 : 1.5;
  const leverageCap = blocked ? '0x' : regimeMode === 'trend' && atrPct < 2 ? '5x' : atrPct < 2.5 ? '3x' : '2x';

  return {
    blocked,
    action: blocked ? 'block' : noTrade ? 'flat' : positionPct <= 30 ? 'reduce' : 'normal',
    positionPct,
    maxSingleLossPct,
    maxDailyLossPct,
    leverageCap,
    reasons,
    warnings,
  };
}

module.exports = {
  DEFAULT_TRADING_EVENTS,
  alignBasisSeries,
  buildRiskOverlay,
  computeBasisSnapshot,
  deriveRegime,
  getEventWindow,
  getFundingCountdown,
  getKoreaSessionState,
  inferNextFundingTimeMs,
};
