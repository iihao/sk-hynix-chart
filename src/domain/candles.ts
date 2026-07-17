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
