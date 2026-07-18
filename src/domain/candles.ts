export interface SpotTickInput {
  ts: number;
  price: number;
  after_hours_price?: number | null;
}

export interface SpotCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sampleCount: number;
}

export type ContinuousSpotSource = 'spot-flat' | 'binance-fallback' | 'none';

function observedPrice(tick: SpotTickInput): number {
  return typeof tick.after_hours_price === 'number' ? tick.after_hours_price : tick.price;
}

export function buildSpotCandles(ticks: SpotTickInput[], intervalSec: number): SpotCandle[] {
  if (ticks.length === 0) return [];
  const candles: SpotCandle[] = [];
  let bucket = Math.floor(ticks[0].ts / intervalSec) * intervalSec;
  let open = observedPrice(ticks[0]);
  let high = open;
  let low = open;
  let close = open;
  let sampleCount = 1;

  const flush = () => candles.push({
    time: bucket, open, high, low, close, volume: 0, sampleCount,
  });

  for (const tick of ticks.slice(1)) {
    const nextBucket = Math.floor(tick.ts / intervalSec) * intervalSec;
    const price = observedPrice(tick);
    if (nextBucket !== bucket) {
      flush();
      bucket = nextBucket;
      open = price;
      high = price;
      low = price;
      close = price;
      sampleCount = 1;
      continue;
    }
    close = price;
    high = Math.max(high, price);
    low = Math.min(low, price);
    sampleCount++;
  }
  flush();
  return candles;
}

export function extendFlatCandlesToNow(
  candles: SpotCandle[],
  input: { nowSec: number; intervalSec: number; price?: number | null },
): SpotCandle[] {
  if (candles.length === 0) return [];
  const intervalSec = Math.max(1, Math.floor(input.intervalSec));
  const nowBucket = Math.floor(input.nowSec / intervalSec) * intervalSec;
  const result = [...candles];
  const last = result[result.length - 1];
  const flatPrice = typeof input.price === 'number' && Number.isFinite(input.price)
    ? input.price
    : last.close;

  for (let time = last.time + intervalSec; time <= nowBucket; time += intervalSec) {
    result.push({
      time,
      open: flatPrice,
      high: flatPrice,
      low: flatPrice,
      close: flatPrice,
      volume: 0,
      sampleCount: 0,
    });
  }

  return result;
}

export function buildContinuousSpotCandles(input: {
  candles: SpotCandle[];
  nowSec: number;
  intervalSec: number;
  spotPrice?: number | null;
  fallbackPrice?: number | null;
}): { candles: SpotCandle[]; source: ContinuousSpotSource; price: number | null } {
  const intervalSec = Math.max(1, Math.floor(input.intervalSec));
  const fallbackPrice = typeof input.fallbackPrice === 'number' && Number.isFinite(input.fallbackPrice)
    ? input.fallbackPrice
    : null;

  if (input.candles.length > 0) {
    const candles = extendFlatCandlesToNow(input.candles, {
      nowSec: input.nowSec,
      intervalSec,
      price: input.candles[input.candles.length - 1].close,
    });
    return { candles, source: 'spot-flat', price: candles[candles.length - 1]?.close ?? null };
  }

  const spotPrice = typeof input.spotPrice === 'number' && Number.isFinite(input.spotPrice)
    ? input.spotPrice
    : fallbackPrice;
  if (!spotPrice) return { candles: [], source: 'none', price: null };

  const nowBucket = Math.floor(input.nowSec / intervalSec) * intervalSec;
  return {
    source: fallbackPrice && spotPrice === fallbackPrice ? 'binance-fallback' : 'spot-flat',
    price: spotPrice,
    candles: [{
      time: nowBucket,
      open: spotPrice,
      high: spotPrice,
      low: spotPrice,
      close: spotPrice,
      volume: 0,
      sampleCount: 0,
    }],
  };
}
