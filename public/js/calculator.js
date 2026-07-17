import { state, $ } from './utils.js';

/* ── Floating Calculator State ── */
let fpCalcDirection = 'long';

/* ── Floating Calculator Toggle ── */
export function toggleCalculator() {
  $('calcPanel').classList.toggle('show');
}

/* ── Floating Calculator Direction ── */
export function fpSetDirection(dir) {
  fpCalcDirection = dir;
  $('fpBtnLong').classList.toggle('active', dir === 'long');
  $('fpBtnShort').classList.toggle('active', dir === 'short');
}

/* ── Floating Calculator Use Current Price ── */
export function fpUseCurrentPrice() {
  if (state.currentBinancePrice) {
    $('fpCalcExit').value = state.currentBinancePrice.toFixed(2);
    fpCalculatePnl();
  }
}

export function syncBinanceQuote(price, fundingRate) {
  if (Number.isFinite(Number(price)) && Number(price) > 0) {
    state.currentBinancePrice = Number(price);
    const entryInput = $('fpCalcEntry');
    if (entryInput && !entryInput.value) entryInput.value = state.currentBinancePrice.toFixed(2);
  }
  if (Number.isFinite(Number(fundingRate))) {
    const fundingInput = $('fpCalcFunding');
    if (fundingInput) {
      fundingInput.value = (Number(fundingRate) * 100).toFixed(4) + '%';
      fundingInput.dataset.rate = String(fundingRate);
    }
  }
}

/* ── Floating Calculator Calculate ── */
export async function fpCalculatePnl() {
  const entryPrice = parseFloat($('fpCalcEntry').value);
  const exitPrice = parseFloat($('fpCalcExit').value);
  const leverage = parseInt($('fpCalcLeverage').value);
  const positionSize = parseFloat($('fpCalcSize').value);
  const feeType = $('fpCalcFeeType').value;
  const fundingInput = $('fpCalcFunding');
  const fundingRate = parseFloat(fundingInput.dataset.rate) || 0;
  const fundingCount = parseInt($('fpCalcFundingCount').value) || 0;

  if (!entryPrice || !exitPrice || !positionSize) {
    alert('请填写完整参数');
    return;
  }

  try {
    const res = await fetch('/api/calculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entryPrice,
        exitPrice,
        leverage,
        positionSize,
        direction: fpCalcDirection,
        feeType,
        fundingRate,
        fundingCount,
      }),
    });
    if (!res.ok) throw new Error('计算失败');
    const data = await res.json();

    $('fpCalcResult').style.display = 'block';
    $('fpResMargin').textContent = '$' + data.margin.toFixed(2);
    $('fpResQty').textContent = data.quantity.toFixed(6);
    $('fpResOpenFee').textContent = '$' + data.openFee.toFixed(2);
    $('fpResCloseFee').textContent = '$' + data.closeFee.toFixed(2);
    $('fpResFunding').textContent = '$' + data.fundingCost.toFixed(2);
    $('fpResTotalFee').textContent = '$' + data.totalFee.toFixed(2);

    const pnlEl = $('fpResPnl');
    pnlEl.textContent =
      (data.pnl >= 0 ? '+' : '') + '$' + data.pnl.toFixed(2);
    pnlEl.className =
      'fp-result-val ' + (data.pnl >= 0 ? 'profit' : 'loss');

    const netPnlEl = $('fpResNetPnl');
    netPnlEl.textContent =
      (data.netPnl >= 0 ? '+' : '') +
      '$' +
      data.netPnl.toFixed(2) +
      ' (' +
      data.roi.toFixed(1) +
      '%)';
    netPnlEl.className = 'fp-result-total-val';
    netPnlEl.style.color =
      data.netPnl >= 0 ? 'var(--green)' : 'var(--red)';

    $('fpResLiq').textContent = '$' + data.liquidationPrice.toFixed(2);
  } catch (e) {
    alert('计算错误: ' + e.message);
  }
}

/* ── Fetch Binance Price ── */
export async function fetchBinancePrice() {
  try {
    const res = await fetch('/api/binance/price');
    if (res.ok) {
      const data = await res.json();
      syncBinanceQuote(data.price, data.fundingRate);
    }
  } catch (e) {
    console.error('Failed to fetch Binance price:', e);
  }
}
