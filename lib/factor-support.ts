// lib/factor-support.ts

import { Factor } from '../types';

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

const TIMEFRAME_ALIAS_MAP: Record<string, string> = {
  m1: '1m',
  '1m': '1m',
  m5: '5m',
  '5m': '5m',
  m15: '15m',
  '15m': '15m',
  h1: '1h',
  '1h': '1h',
};

interface TimeframeConfig {
  rangeSec: number;
  intervalSec: number;
}

const TIMEFRAME_CONFIG: Record<string, TimeframeConfig> = {
  '1m': { rangeSec: 3 * 86400, intervalSec: 60 },
  '5m': { rangeSec: 7 * 86400, intervalSec: 300 },
  '15m': { rangeSec: 30 * 86400, intervalSec: 900 },
  '1h': { rangeSec: 90 * 86400, intervalSec: 3600 },
};

export function normalizeTimeframe(tf: string | undefined | null): string {
  return TIMEFRAME_ALIAS_MAP[String(tf || '').trim()] || '5m';
}

export function getTimeframeConfig(tf: string): TimeframeConfig & { tf: string } {
  const normalized = normalizeTimeframe(tf);
  return { tf: normalized, ...TIMEFRAME_CONFIG[normalized] };
}

export function decodeHtmlEntities(text: string): string {
  if (!text) return '';
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .trim();
}

export function parsePubDate(text: string): number | null {
  if (!text) return null;
  const ms = Date.parse(decodeHtmlEntities(text));
  return Number.isFinite(ms) ? ms : null;
}

interface RssItem {
  title: string;
  publishedAt: number | null;
}

export function extractRssItems(xml: string): RssItem[] {
  if (!xml) return [];
  const items: RssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = itemRe.exec(xml))) {
    const body = itemMatch[1];
    const titleMatch = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) continue;
    const title = decodeHtmlEntities(titleMatch[1]);
    const pubDateMatch = body.match(/<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i);
    if (title) {
      items.push({
        title,
        publishedAt: pubDateMatch ? parsePubDate(pubDateMatch[1]) : null,
      });
    }
  }
  return items;
}

export function countKeywordHits(title: string, keywords: string[]): number {
  return (keywords || []).reduce((sum, keyword) => sum + (title.includes(keyword) ? 1 : 0), 0);
}

interface ParseGoogleNewsOptions {
  limit?: number;
  nowMs?: number;
  maxAgeHours?: number;
}

interface GoogleNewsResult {
  headlines: string[];
  positive: number;
  negative: number;
  score: number;
  latestPublishedAt: number | null;
  recentCount: number;
}

export function parseGoogleNewsRss(
  xml: string,
  positiveKeywords: string[],
  negativeKeywords: string[],
  options: ParseGoogleNewsOptions | number = {}
): GoogleNewsResult {
  const { limit = 20, nowMs = Date.now(), maxAgeHours = 24 * 7 } =
    typeof options === 'number' ? { limit: options } : options;
  const items = extractRssItems(xml);
  const recentItems = items.filter(item => {
    if (item.publishedAt == null) return true;
    const ageHours = (nowMs - item.publishedAt) / 3600000;
    return ageHours <= maxAgeHours;
  });
  const displayItems = (recentItems.length ? recentItems : items).slice(0, limit);
  const scoredItems = recentItems.slice(0, limit);
  const headlines = displayItems.map(item => item.title);
  let positive = 0;
  let negative = 0;

  for (const item of scoredItems) {
    positive += countKeywordHits(item.title, positiveKeywords);
    negative += countKeywordHits(item.title, negativeKeywords);
  }

  const total = positive + negative || 1;
  const latestPublishedAt = displayItems.reduce<number | null>((latest, item) => {
    if (item.publishedAt == null) return latest;
    return latest == null || item.publishedAt > latest ? item.publishedAt : latest;
  }, null);
  return {
    headlines,
    positive,
    negative,
    score: round1(((positive - negative) / total) * 5),
    latestPublishedAt,
    recentCount: scoredItems.length,
  };
}

interface MapRow {
  timestamp?: number;
  ts?: number;
  time?: number;
  [key: string]: unknown;
}

export function mapByTimestamp<T>(rows: MapRow[], mapper: (row: MapRow) => T): Map<number, T> {
  const map = new Map<number, T>();
  for (const row of rows || []) {
    const rawTs = row.timestamp || row.ts || row.time;
    if (rawTs == null) continue;
    const ts = Math.floor(Number(rawTs) / 1000);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    map.set(ts, mapper(row));
  }
  return map;
}

export function unionTimestampSets(maps: Map<number, unknown>[]): number[] {
  const set = new Set<number>();
  for (const map of maps.filter(Boolean)) {
    for (const key of map.keys()) set.add(key);
  }
  return [...set].sort((a, b) => a - b);
}

interface SentimentRow {
  ts: number;
  ls_ratio: number;
  ls_long_pct: number;
  ls_short_pct: number;
  taker_ratio: number;
  taker_buy_vol: number;
  taker_sell_vol: number;
  open_interest: number;
  oi_value: number;
  top_ls_ratio: number;
  top_long_pct: number;
  top_short_pct: number;
}

interface MergeSentimentInput {
  lsData?: MapRow[];
  takerData?: MapRow[];
  oiData?: MapRow[];
  topData?: MapRow[];
}

export function mergeSentimentHistory({
  lsData = [],
  takerData = [],
  oiData = [],
  topData = [],
}: MergeSentimentInput): SentimentRow[] {
  const lsMap = mapByTimestamp(lsData, row => ({
    ls_ratio: parseFloat(row.longShortRatio as string) || 1,
    ls_long_pct: parseFloat(row.longAccount as string) || 0.5,
    ls_short_pct: parseFloat(row.shortAccount as string) || 0.5,
  }));
  const takerMap = mapByTimestamp(takerData, row => ({
    taker_ratio: parseFloat(row.buySellRatio as string) || 1,
    taker_buy_vol: parseFloat(row.buyVol as string) || 0,
    taker_sell_vol: parseFloat(row.sellVol as string) || 0,
  }));
  const oiMap = mapByTimestamp(oiData, row => ({
    open_interest: parseFloat(row.sumOpenInterest as string) || 0,
    oi_value: parseFloat(row.sumOpenInterestValue as string) || 0,
  }));
  const topMap = mapByTimestamp(topData, row => ({
    top_ls_ratio: parseFloat(row.longShortRatio as string) || 1,
    top_long_pct: parseFloat(row.longAccount as string) || 0.5,
    top_short_pct: parseFloat(row.shortAccount as string) || 0.5,
  }));

  const timestamps = unionTimestampSets([lsMap, takerMap, oiMap, topMap]);
  const state: Record<string, any> = { ls: null, taker: null, oi: null, top: null };
  const rows: SentimentRow[] = [];

  for (const ts of timestamps) {
    if (lsMap.has(ts)) state.ls = lsMap.get(ts);
    if (takerMap.has(ts)) state.taker = takerMap.get(ts);
    if (oiMap.has(ts)) state.oi = oiMap.get(ts);
    if (topMap.has(ts)) state.top = topMap.get(ts);
    if (!state.ls || !state.taker || !state.oi || !state.top) continue;
    rows.push({
      ts,
      ...state.ls,
      ...state.taker,
      ...state.oi,
      ...state.top,
    });
  }

  return rows;
}

interface ExpectedFactor {
  category: string;
  label: string;
}

interface SourceHealth {
  status: string;
}

interface FactorCoverageResult {
  expectedCount: number;
  activeCount: number;
  missingCount: number;
  coveragePct: number;
  activeCategories: string[];
  activeLabels: string[];
  missingCategories: string[];
  missingLabels: string[];
  healthySources: number;
  totalSources: number;
}

export function buildFactorCoverage({
  expectedFactors = [],
  factors = [],
  sourceHealth = [],
}: {
  expectedFactors?: ExpectedFactor[];
  factors?: { category: string }[];
  sourceHealth?: SourceHealth[];
}): FactorCoverageResult {
  const expectedByCategory = new Map(expectedFactors.map(f => [f.category, f]));
  const activeCategories = factors.map(f => f.category);
  const activeSet = new Set(activeCategories);
  const missing = expectedFactors.filter(f => !activeSet.has(f.category));
  const expectedCount = expectedFactors.length;
  const activeCount = factors.length;

  return {
    expectedCount,
    activeCount,
    missingCount: missing.length,
    coveragePct: expectedCount ? round1(activeCount / expectedCount * 100) : 0,
    activeCategories,
    activeLabels: activeCategories.map(category => expectedByCategory.get(category)?.label || category),
    missingCategories: missing.map(f => f.category),
    missingLabels: missing.map(f => f.label),
    healthySources: sourceHealth.filter(s => s.status === 'ok').length,
    totalSources: sourceHealth.length,
  };
}

interface OpenInterestMetric {
  metric: 'oi_value' | 'open_interest';
  value: number;
}

function getOpenInterestMetric(row: Record<string, unknown>): OpenInterestMetric | null {
  const oiValue = Number(row?.oi_value) || 0;
  if (oiValue > 0) return { metric: 'oi_value', value: oiValue };
  const contracts = Number(row?.open_interest) || 0;
  if (contracts > 0) return { metric: 'open_interest', value: contracts };
  return null;
}

interface OpenInterestSignal {
  score: number;
  weight: number;
  metric: string | null;
  direction: string;
  latestValue: number;
  baselineValue: number;
  oiChangePct: number;
  priceChangePct: number;
  reason: string;
}

function emptyOpenInterestSignal(reason: string, extras: Partial<OpenInterestSignal> = {}): OpenInterestSignal {
  return {
    score: 0,
    weight: 0,
    metric: extras.metric ?? null,
    direction: 'neutral',
    latestValue: extras.latestValue ?? 0,
    baselineValue: extras.baselineValue ?? 0,
    oiChangePct: 0,
    priceChangePct: 0,
    reason,
  };
}

interface ScoreOpenInterestInput {
  sentimentRows?: Record<string, unknown>[];
  priceNow: number;
  pricePrev: number;
  maxLookback?: number;
}

export function scoreOpenInterestSignal({
  sentimentRows = [],
  priceNow,
  pricePrev,
  maxLookback = 3,
}: ScoreOpenInterestInput): OpenInterestSignal {
  if (!Array.isArray(sentimentRows) || sentimentRows.length < 2) {
    return emptyOpenInterestSignal('insufficient-history');
  }
  if (!Number.isFinite(priceNow) || !Number.isFinite(pricePrev) || pricePrev === 0) {
    return emptyOpenInterestSignal('insufficient-price-history');
  }

  const latestMetric = getOpenInterestMetric(sentimentRows[sentimentRows.length - 1]);
  if (!latestMetric) {
    return emptyOpenInterestSignal('missing-open-interest');
  }

  let baselineMetric: OpenInterestMetric | null = null;
  for (let offset = 2; offset <= Math.min(sentimentRows.length, maxLookback + 1); offset++) {
    const candidate = getOpenInterestMetric(sentimentRows[sentimentRows.length - offset]);
    if (candidate && candidate.metric === latestMetric.metric && candidate.value > 0) {
      baselineMetric = candidate;
      break;
    }
  }

  if (!baselineMetric) {
    return emptyOpenInterestSignal('insufficient-history', {
      metric: latestMetric.metric,
      latestValue: latestMetric.value,
    });
  }

  const oiChangePct = (latestMetric.value - baselineMetric.value) / baselineMetric.value;
  const priceChangePct = (priceNow - pricePrev) / pricePrev;
  const absOiChange = Math.abs(oiChangePct);
  const absPriceChange = Math.abs(priceChangePct);

  let score = 0;
  let direction = 'neutral';
  if (absOiChange >= 0.003 && absPriceChange >= 0.002) {
    if (oiChangePct > 0 && priceChangePct > 0) {
      score = 3;
      direction = 'bullish';
    } else if (oiChangePct > 0 && priceChangePct < 0) {
      score = -3;
      direction = 'bearish';
    } else if (oiChangePct < 0 && priceChangePct > 0) {
      score = 1;
      direction = 'short-covering';
    } else if (oiChangePct < 0 && priceChangePct < 0) {
      score = -1;
      direction = 'long-unwind';
    }
  }

  return {
    score,
    weight: 0.55,
    metric: latestMetric.metric,
    direction,
    latestValue: latestMetric.value,
    baselineValue: baselineMetric.value,
    oiChangePct,
    priceChangePct,
    reason: 'ok',
  };
}

export default {
  buildFactorCoverage,
  decodeHtmlEntities,
  extractRssItems,
  getTimeframeConfig,
  mergeSentimentHistory,
  normalizeTimeframe,
  parseGoogleNewsRss,
  parsePubDate,
  scoreOpenInterestSignal,
};
