export interface FxTick {
  ts: number;
  mid: number;
  bid?: number | null;
  ask?: number | null;
  source?: string;
}

export function findFxAtOrBefore(
  ticks: FxTick[],
  decisionTs: number,
  toleranceSec: number,
): FxTick | undefined {
  let selected: FxTick | undefined;
  for (const tick of ticks) {
    if (tick.ts > decisionTs) break;
    if (!selected || tick.ts > selected.ts) selected = tick;
  }
  if (!selected || decisionTs - selected.ts > toleranceSec) return undefined;
  return selected;
}
