export type CollectorState = 'starting' | 'healthy' | 'degraded' | 'open' | 'stopped';
export type CollectorTransport = 'direct' | 'proxy' | 'local' | 'none';

export function createCollectorRuntime(options: {key: string; now?: () => number}) {
  const now = options.now || Date.now;
  let running = false;
  const state = {
    key: options.key,
    state: 'starting' as CollectorState,
    transport: 'none' as CollectorTransport,
    lastAttemptAt: null as number | null,
    lastSuccessAt: null as number | null,
    lastExchangeTs: null as number | null,
    consecutiveFailures: 0,
    nextRetryAt: null as number | null,
    errorCode: null as string | null,
    errorMessage: null as string | null,
  };

  async function run<T>(action: () => Promise<T>, transport: CollectorTransport = 'none') {
    if (running || state.state === 'stopped') return {skipped: true} as const;
    running = true;
    state.lastAttemptAt = now();
    state.transport = transport;
    try {
      const value = await action();
      state.state = 'healthy';
      state.lastSuccessAt = now();
      state.consecutiveFailures = 0;
      state.errorCode = null;
      state.errorMessage = null;
      return {skipped: false, value} as const;
    } catch (error) {
      state.state = 'degraded';
      state.consecutiveFailures++;
      state.errorCode = error instanceof Error ? error.name : 'ERROR';
      state.errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      running = false;
    }
  }

  return {
    run,
    snapshot: () => ({...state}),
    update: (updates: Partial<typeof state>) => Object.assign(state, updates),
    stop: () => { state.state = 'stopped'; },
  };
}
