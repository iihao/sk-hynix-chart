import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardController } from '../public/js/dashboard-controller.mjs';

function createHarness({ deferredFetch = false } = {}) {
  const fetchUrls = [];
  const pendingFetches = [];
  const eventSources = [];
  const intervals = new Map();
  const timeouts = new Map();
  let nextTimerId = 1;

  const fetch = (url) => {
    fetchUrls.push(url);
    if (deferredFetch) {
      return new Promise((resolve) => pendingFetches.push(resolve));
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ source: url.includes('yahoo') ? 'yahoo' : 'naver', serverTime: 1 }),
    });
  };

  const createEventSource = (url) => {
    const eventSource = {
      url,
      closed: false,
      close() { this.closed = true; },
      onopen: null,
      onmessage: null,
      onerror: null,
    };
    eventSources.push(eventSource);
    return eventSource;
  };

  return {
    fetchUrls,
    eventSources,
    dependencies: {
      fetch,
      createEventSource,
      setInterval(fn, delay) {
        const id = nextTimerId++;
        intervals.set(id, { fn, delay });
        return id;
      },
      clearInterval(id) { intervals.delete(id); },
      setTimeout(fn, delay) {
        const id = nextTimerId++;
        timeouts.set(id, { fn, delay });
        return id;
      },
      clearTimeout(id) { timeouts.delete(id); },
      now: () => 1000,
      onSnapshot() {},
      onConnection() {},
      onError() {},
    },
    activeIntervals(delay) {
      return [...intervals.values()].filter((timer) => timer.delay === delay).length;
    },
    disconnectSse() {
      eventSources[eventSources.length - 1].onerror?.(new Error('disconnect'));
    },
    connectSse() {
      eventSources[eventSources.length - 1].onopen?.();
    },
    resolveFetch(index, payload) {
      pendingFetches[index]({ ok: true, json: async () => payload });
    },
  };
}

test('starts with Naver and performs one bootstrap fetch', async () => {
  const harness = createHarness();
  const controller = createDashboardController(harness.dependencies);
  await controller.start();

  assert.deepEqual(harness.fetchUrls, ['/api/data?source=naver']);
  assert.deepEqual(harness.eventSources.map((source) => source.url), ['/api/stream?source=naver']);
  controller.stop();
});

test('starts one fallback poll after SSE disconnect and stops it after recovery', async () => {
  const harness = createHarness();
  const controller = createDashboardController(harness.dependencies);
  await controller.start();

  harness.disconnectSse();
  harness.disconnectSse();
  assert.equal(harness.activeIntervals(30000), 1);

  harness.connectSse();
  assert.equal(harness.activeIntervals(30000), 0);
  controller.stop();
});

test('ignores a stale response after the selected source changes', async () => {
  const snapshots = [];
  const harness = createHarness({ deferredFetch: true });
  harness.dependencies.onSnapshot = (snapshot) => snapshots.push(snapshot);
  const controller = createDashboardController(harness.dependencies);

  const first = controller.start();
  const second = controller.setSource('yahoo');
  harness.resolveFetch(0, { source: 'naver', serverTime: 1 });
  harness.resolveFetch(1, { source: 'yahoo', serverTime: 2 });
  await Promise.all([first, second]);

  assert.equal(controller.getState().snapshot.source, 'yahoo');
  assert.deepEqual(snapshots.map((snapshot) => snapshot.source), ['yahoo']);
  controller.stop();
});
