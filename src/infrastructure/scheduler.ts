type TimerHandle = ReturnType<typeof setTimeout>;

export function createScheduler(timers: {
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
} = {}) {
  const timeouts = new Set<TimerHandle>();
  const intervals = new Set<TimerHandle>();
  const setTimeoutFn = timers.setTimeout || setTimeout;
  const clearTimeoutFn = timers.clearTimeout || clearTimeout;
  const setIntervalFn = timers.setInterval || setInterval;
  const clearIntervalFn = timers.clearInterval || clearInterval;

  return {
    setTimeout(callback: () => void, delayMs: number) {
      const handle = setTimeoutFn(() => {
        timeouts.delete(handle);
        callback();
      }, delayMs);
      timeouts.add(handle);
      return handle;
    },
    setInterval(callback: () => void, delayMs: number) {
      const handle = setIntervalFn(callback, delayMs);
      intervals.add(handle);
      return handle;
    },
    stopAll() {
      for (const handle of timeouts) clearTimeoutFn(handle);
      for (const handle of intervals) clearIntervalFn(handle);
      timeouts.clear();
      intervals.clear();
    },
    snapshot() {
      return {timeouts: timeouts.size, intervals: intervals.size};
    },
  };
}
