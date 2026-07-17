export function createShutdownCoordinator(options: {
  timeoutMs?: number;
  stopTimers: () => void;
  stopCollectors?: () => void;
  closeClients?: () => void;
  checkpoint?: () => void;
  closeDatabase?: () => void;
  closeServer: (done: (error?: Error) => void) => void;
  exit?: (code: number) => void;
  log?: (message: string) => void;
  error?: (message: string, error?: unknown) => void;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}) {
  let stopping: Promise<void> | null = null;
  const timeoutMs = options.timeoutMs || 5000;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;

  async function shutdown(signal = 'manual') {
    if (stopping) return stopping;
    stopping = new Promise<void>((resolve) => {
      options.log?.(`[shutdown] received ${signal}`);
      options.stopTimers();
      options.stopCollectors?.();
      options.closeClients?.();
      options.checkpoint?.();
      let finished = false;
      const finish = (code: number, error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeoutFn(timeout);
        if (error) options.error?.('[shutdown] server close error', error);
        try {
          options.closeDatabase?.();
        } catch (dbError) {
          options.error?.('[shutdown] database close error', dbError);
          code = code || 1;
        }
        options.exit?.(code);
        resolve();
      };
      const timeout = setTimeoutFn(() => finish(1, new Error('shutdown timeout')), timeoutMs);
      options.closeServer((error?: Error) => finish(error ? 1 : 0, error));
    });
    return stopping;
  }

  return {shutdown};
}
