export type CircuitState = 'closed' | 'open' | 'half-open' | 'stopped';

export function createCircuitBreaker<T>(options: {
  now?: () => number;
  failureThreshold?: number;
  initialCooldownMs?: number;
  maxCooldownMs?: number;
} = {}) {
  const now = options.now || Date.now;
  const failureThreshold = options.failureThreshold || 3;
  const initialCooldownMs = options.initialCooldownMs || 30000;
  const maxCooldownMs = options.maxCooldownMs || 300000;
  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let cooldownMs = initialCooldownMs;
  let nextRetryAt: number | null = null;
  let probePromise: Promise<T> | null = null;

  const fail = () => {
    consecutiveFailures++;
    if (state === 'half-open') cooldownMs = Math.min(maxCooldownMs, cooldownMs * 2);
    if (state === 'half-open' || consecutiveFailures >= failureThreshold) {
      state = 'open';
      nextRetryAt = now() + cooldownMs;
    }
  };

  const succeed = () => {
    state = 'closed';
    consecutiveFailures = 0;
    cooldownMs = initialCooldownMs;
    nextRetryAt = null;
  };

  async function execute(action: () => Promise<T>): Promise<T> {
    if (state === 'stopped') throw new Error('CIRCUIT_STOPPED');
    if (state === 'open') {
      if (nextRetryAt != null && now() < nextRetryAt) throw new Error('CIRCUIT_OPEN');
      state = 'half-open';
    }
    if (state === 'half-open' && probePromise) return probePromise;
    const run = (async () => {
      try {
        const value = await action();
        succeed();
        return value;
      } catch (error) {
        fail();
        throw error;
      } finally {
        probePromise = null;
      }
    })();
    if (state === 'half-open') probePromise = run;
    return run;
  }

  return {
    execute,
    snapshot: () => ({state, consecutiveFailures, cooldownMs, nextRetryAt}),
    stop: () => { state = 'stopped'; probePromise = null; },
  };
}
