export type KoreaSession = 'pre' | 'regular' | 'after' | 'closed';

export function getKoreaSession(nowMs: number): KoreaSession {
  const kst = new Date(nowMs + 9 * 3600000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return 'closed';
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  if (minutes >= 480 && minutes < 540) return 'pre';
  if (minutes >= 540 && minutes <= 930) return 'regular';
  if (minutes > 930 && minutes <= 1080) return 'after';
  return 'closed';
}

export function canRecordSpotTick(input: {
  nowMs: number;
  marketOpen: boolean;
  hasFreshAfterHours: boolean;
}): boolean {
  const session = getKoreaSession(input.nowMs);
  if (session === 'regular') return input.marketOpen;
  if (session === 'after') return input.hasFreshAfterHours;
  return false;
}

export function classifyObservationAge(input: {
  nowSec: number;
  exchangeTs: number;
  maxAgeSec: number;
}): { eligible: boolean; ageSec: number; quality: 'live' | 'stale' } {
  const ageSec = Math.max(0, input.nowSec - input.exchangeTs);
  const eligible = ageSec <= input.maxAgeSec;
  return { eligible, ageSec, quality: eligible ? 'live' : 'stale' };
}
