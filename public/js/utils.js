/* ── Constants ── */
export const KRW_USD_DEFAULT = 1544;

export const BN = {
  bg: '#0b0e11',
  grid: '#161a1e',
  border: '#2b3139',
  text: '#848e9c',
  textBright: '#eaecef',
  up: '#0ecb81',
  down: '#f6465d',
  upVol: 'rgba(14,203,129,0.18)',
  downVol: 'rgba(246,70,93,0.18)',
  crosshair: '#474d57',
};

export const LABELS = {
  normal: {
    ticker: 'SK HYNIX',
    sub: '000660.KS',
    stat1: '前收',
    stat2: '最高',
    stat3: '最低',
    tf: ['1分', '5分', '15分', '1时'],
    watermark: '000660',
    ohlc: ['O', 'H', 'L', 'C'],
    title: (p, pct, up) => `${up ? '▲' : '▼'} ${p} (${pct}) SK Hynix`,
  },
  stealth: {
    ticker: 'prod-cluster-east',
    sub: 'Grafana v10.2.3',
    stat1: 'baseline',
    stat2: 'peak',
    stat3: 'trough',
    tf: ['1m', '5m', '15m', '1h'],
    watermark: 'PROD-EAST-01',
    ohlc: ['min', 'p50', 'p95', 'max'],
    title: (p, pct, up) => `p99 ${p}ms (${pct}%) — prod-east`,
  },
};

/* ── State ── */
export const state = {
  krwUsdRate: KRW_USD_DEFAULT,
  currency: 'USD',
  activeTF: 'm5',
  rawData: {},
  charts: {},
  stealthMode: false,
  currentBinancePrice: 0,
  currentSource: 'yahoo',
  lastServerTime: 0,
};

/* ── Helper Functions ── */
export function convertP(v) {
  return state.currency === 'USD'
    ? +(v / state.krwUsdRate).toFixed(2)
    : Math.round(v);
}

export function fmtPrice(v) {
  if (state.currency === 'USD') return '$' + v.toFixed(2);
  return '₩' + Math.round(v).toLocaleString();
}

export function getThemeColors() {
  return state.stealthMode
    ? {
        bg: '#111217',
        grid: '#1c1f24',
        border: '#25292e',
        text: '#6b7280',
        textBright: '#c9d1d9',
        up: '#3b82f6',
        down: '#6b7280',
        upVol: 'rgba(59,130,246,0.15)',
        downVol: 'rgba(107,114,128,0.12)',
        crosshair: '#374151',
      }
    : BN;
}

export function getLabels() {
  return state.stealthMode ? LABELS.stealth : LABELS.normal;
}

/* ── DOM Helpers ── */
export function $(id) {
  return document.getElementById(id);
}

export function showError(msg) {
  const t = $('errorToast');
  if (t) {
    t.textContent = '数据获取失败: ' + msg;
    t.style.display = 'block';
    setTimeout(() => (t.style.display = 'none'), 8000);
  }
}
