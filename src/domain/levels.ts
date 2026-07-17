export interface PriceLevel {
  price: number;
  strength: number;
  type?: 'support' | 'resistance';
}

export interface LevelSetInput {
  support: PriceLevel[];
  resistance: PriceLevel[];
}

export function buildLevelGroups(input: {
  spot: LevelSetInput;
  futures: LevelSetInput;
}) {
  return {
    spot: {
      instrument: '000660',
      source: 'naver',
      currency: 'KRW' as const,
      support: input.spot.support,
      resistance: input.spot.resistance,
    },
    futures: {
      instrument: 'SKHYNIXUSDT',
      source: 'binance',
      currency: 'USDT' as const,
      support: input.futures.support,
      resistance: input.futures.resistance,
    },
  };
}
