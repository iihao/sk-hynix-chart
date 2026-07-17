const FALLBACK_POLL_MS = 30000;
const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

export function createDashboardController(dependencies) {
  const {
    fetch,
    createEventSource,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    now,
    onSnapshot = () => {},
    onConnection = () => {},
    onError = () => {},
  } = dependencies;

  const state = {
    source: 'naver',
    connection: 'connecting',
    snapshot: null,
    snapshotReceivedAt: 0,
    panelStatus: {
      indicators: 'loading',
      factors: 'loading',
      news: 'loading',
    },
  };

  let stopped = true;
  let sourceRevision = 0;
  let eventSource = null;
  let reconnectTimer = null;
  let fallbackTimer = null;
  let reconnectAttempt = 0;
  let snapshotRequest = null;
  let snapshotRequestRevision = -1;

  function emitConnection(connection) {
    state.connection = connection;
    onConnection(connection, getState());
  }

  function stopFallbackPolling() {
    if (fallbackTimer != null) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  }

  function startFallbackPolling() {
    if (fallbackTimer != null || stopped) return;
    fallbackTimer = setInterval(() => {
      void refreshSnapshot();
    }, FALLBACK_POLL_MS);
  }

  function clearReconnectTimer() {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function closeEventSource() {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  }

  function scheduleReconnect(revision) {
    if (reconnectTimer != null || stopped || revision !== sourceRevision) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped && revision === sourceRevision) connectSse(revision);
    }, delay);
  }

  function acceptSnapshot(snapshot, revision) {
    if (stopped || revision !== sourceRevision || !snapshot || typeof snapshot !== 'object') return;
    state.snapshot = snapshot;
    state.snapshotReceivedAt = now();
    onSnapshot(snapshot, getState());
  }

  function connectSse(revision = sourceRevision) {
    closeEventSource();
    clearReconnectTimer();
    if (stopped || revision !== sourceRevision) return;

    emitConnection('connecting');
    const source = createEventSource(`/api/stream?source=${encodeURIComponent(state.source)}`);
    eventSource = source;

    source.onopen = () => {
      if (stopped || revision !== sourceRevision) return;
      reconnectAttempt = 0;
      clearReconnectTimer();
      stopFallbackPolling();
      emitConnection('live');
    };
    source.onmessage = (event) => {
      if (stopped || revision !== sourceRevision) return;
      try {
        acceptSnapshot(JSON.parse(event.data), revision);
        reconnectAttempt = 0;
        stopFallbackPolling();
        emitConnection('live');
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    };
    source.onerror = () => {
      if (stopped || revision !== sourceRevision) return;
      source.close();
      emitConnection(state.snapshot ? 'fallback' : 'offline');
      startFallbackPolling();
      scheduleReconnect(revision);
    };
  }

  async function refreshSnapshot() {
    const revision = sourceRevision;
    if (snapshotRequest && snapshotRequestRevision === revision) return snapshotRequest;
    const source = state.source;
    snapshotRequestRevision = revision;
    snapshotRequest = (async () => {
      try {
        const response = await fetch(`/api/data?source=${encodeURIComponent(source)}`);
        if (!response.ok) throw new Error(`HTTP ${response.status || 500}`);
        const snapshot = await response.json();
        acceptSnapshot(snapshot, revision);
        return snapshot;
      } catch (error) {
        if (revision === sourceRevision) {
          emitConnection(state.snapshot ? 'fallback' : 'offline');
          onError(error instanceof Error ? error.message : String(error));
        }
        return null;
      } finally {
        if (snapshotRequestRevision === revision) snapshotRequest = null;
      }
    })();
    return snapshotRequest;
  }

  async function start() {
    if (!stopped) return refreshSnapshot();
    stopped = false;
    const request = refreshSnapshot();
    connectSse(sourceRevision);
    return request;
  }

  function stop() {
    stopped = true;
    closeEventSource();
    clearReconnectTimer();
    stopFallbackPolling();
  }

  async function setSource(source) {
    if (!['naver', 'yahoo'].includes(source)) throw new Error('INVALID_DASHBOARD_SOURCE');
    sourceRevision++;
    state.source = source;
    reconnectAttempt = 0;
    closeEventSource();
    clearReconnectTimer();
    stopFallbackPolling();
    const request = refreshSnapshot();
    connectSse(sourceRevision);
    return request;
  }

  function markPanel(panel, status) {
    if (!(panel in state.panelStatus)) throw new Error('INVALID_DASHBOARD_PANEL');
    state.panelStatus[panel] = status;
  }

  function getState() {
    return {
      ...state,
      panelStatus: {...state.panelStatus},
    };
  }

  return { start, stop, setSource, refreshSnapshot, markPanel, getState };
}
