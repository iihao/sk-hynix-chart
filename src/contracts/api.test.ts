// src/contracts/api.test.ts
// API 契约测试 - 验证响应符合类型定义

import { describe, it } from 'node:test';
import assert from 'node:assert';

const BASE_URL = 'http://localhost:3456';

// Helper to fetch JSON
async function fetchJSON(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

describe('API Contracts', () => {
  describe('GET /api/indicators', () => {
    it('should return valid indicators response', async () => {
      const data = await fetchJSON('/api/indicators?tf=m5');
      
      // Check required fields
      assert.ok(data.indicators || data.rsi !== undefined, 'Should have indicators');
      assert.ok(Array.isArray(data.signals), 'signals should be array');
      assert.ok(Array.isArray(data.support), 'support should be array');
      assert.ok(Array.isArray(data.resistance), 'resistance should be array');
      assert.ok(Array.isArray(data.times), 'times should be array');
      
      // Check latest values
      if (data.latest) {
        assert.ok(typeof data.latest.rsi === 'number', 'latest.rsi should be number');
        assert.ok(typeof data.latest.macdDif === 'number', 'latest.macdDif should be number');
        assert.ok(typeof data.latest.volRatio === 'number', 'latest.volRatio should be number');
        assert.ok(['bullish', 'bearish', 'neutral'].includes(data.latest.macdState), 'macdState should be valid');
      }
    });
  });

  describe('GET /api/factors', () => {
    it('should return valid factors response', async () => {
      const data = await fetchJSON('/api/factors');
      
      assert.ok(Array.isArray(data.factors), 'factors should be array');
      assert.ok(typeof data.composite === 'number', 'composite should be number');
      assert.ok(['long', 'short', 'neutral'].includes(data.direction), 'direction should be valid');
      assert.ok(typeof data.confidence === 'number', 'confidence should be number');
      assert.ok(data.confidence >= 0 && data.confidence <= 100, 'confidence should be 0-100');
      
      // Check factor structure
      for (const factor of data.factors) {
        assert.ok(typeof factor.category === 'string', 'factor.category should be string');
        assert.ok(typeof factor.label === 'string', 'factor.label should be string');
        assert.ok(typeof factor.score === 'number', 'factor.score should be number');
        assert.ok(typeof factor.weight === 'number', 'factor.weight should be number');
        assert.ok(typeof factor.detail === 'string', 'factor.detail should be string');
      }
    });
  });

  describe('POST /api/strategy', () => {
    it('should return valid strategy response', async () => {
      const data = await fetchJSON('/api/strategy?tf=m5');
      
      assert.ok(['long', 'short', 'neutral'].includes(data.direction), 'direction should be valid');
      assert.ok(typeof data.entry === 'string', 'entry should be string');
      assert.ok(typeof data.stopLoss === 'string', 'stopLoss should be string');
      assert.ok(typeof data.takeProfit === 'string', 'takeProfit should be string');
      assert.ok(['low', 'medium', 'high'].includes(data.riskLevel), 'riskLevel should be valid');
      assert.ok(Array.isArray(data.reasoning), 'reasoning should be array');
      assert.ok(Array.isArray(data.warnings), 'warnings should be array');
      assert.ok(typeof data.confidence === 'number', 'confidence should be number');
      assert.ok(typeof data.riskReward === 'string', 'riskReward should be string');
      assert.ok(typeof data.leverage === 'string', 'leverage should be string');
      
      // Check evidence structure
      assert.ok(data.evidence, 'Should have evidence');
      assert.ok(Array.isArray(data.evidence.for), 'evidence.for should be array');
      assert.ok(Array.isArray(data.evidence.against), 'evidence.against should be array');
      assert.ok(Array.isArray(data.evidence.neutral), 'evidence.neutral should be array');
    });
  });

  describe('GET /api/backtest', () => {
    it('should return valid backtest response', async () => {
      const data = await fetchJSON('/api/backtest?threshold=2&holdBars=12');
      
      if (data.error) {
        // If insufficient data, that's ok
        assert.ok(typeof data.error === 'string', 'error should be string');
        return;
      }
      
      assert.ok(Array.isArray(data.trades), 'trades should be array');
      assert.ok(data.metrics, 'Should have metrics');
      assert.ok(Array.isArray(data.equityCurve), 'equityCurve should be array');
      
      // Check metrics
      assert.ok(typeof data.metrics.totalTrades === 'number', 'totalTrades should be number');
      assert.ok(typeof data.metrics.winRate === 'number', 'winRate should be number');
      assert.ok(typeof data.metrics.totalReturn === 'number', 'totalReturn should be number');
      assert.ok(typeof data.metrics.maxDrawdown === 'number', 'maxDrawdown should be number');
      assert.ok(typeof data.metrics.sharpe === 'number', 'sharpe should be number');
      
      // Check trade structure
      for (const trade of data.trades) {
        assert.ok(typeof trade.entryTime === 'number', 'trade.entryTime should be number');
        assert.ok(typeof trade.exitTime === 'number', 'trade.exitTime should be number');
        assert.ok(['long', 'short'].includes(trade.direction), 'trade.direction should be valid');
        assert.ok(typeof trade.entry === 'number', 'trade.entry should be number');
        assert.ok(typeof trade.exit === 'number', 'trade.exit should be number');
        assert.ok(typeof trade.pnl === 'number', 'trade.pnl should be number');
        assert.ok(typeof trade.pnlPct === 'number', 'trade.pnlPct should be number');
        assert.ok(['signal', 'stopLoss', 'takeProfit', 'timeout'].includes(trade.exitReason), 'trade.exitReason should be valid');
      }
    });
  });

  describe('POST /api/calculate', () => {
    it('should return valid calculator response', async () => {
      const res = await fetch(`${BASE_URL}/api/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entryPrice: 100,
          exitPrice: 110,
          leverage: 10,
          positionSize: 1000,
          direction: 'long',
          feeType: 'taker',
          fundingRate: 0.0001,
          fundingCount: 3,
        }),
      });
      const data = await res.json();
      
      assert.ok(typeof data.entryPrice === 'number', 'entryPrice should be number');
      assert.ok(typeof data.exitPrice === 'number', 'exitPrice should be number');
      assert.ok(typeof data.leverage === 'number', 'leverage should be number');
      assert.ok(typeof data.positionSize === 'number', 'positionSize should be number');
      assert.ok(typeof data.margin === 'number', 'margin should be number');
      assert.ok(typeof data.quantity === 'number', 'quantity should be number');
      assert.ok(['long', 'short'].includes(data.direction), 'direction should be valid');
      assert.ok(typeof data.pnl === 'number', 'pnl should be number');
      assert.ok(typeof data.openFee === 'number', 'openFee should be number');
      assert.ok(typeof data.closeFee === 'number', 'closeFee should be number');
      assert.ok(typeof data.totalFee === 'number', 'totalFee should be number');
      assert.ok(typeof data.fundingCost === 'number', 'fundingCost should be number');
      assert.ok(typeof data.netPnl === 'number', 'netPnl should be number');
      assert.ok(typeof data.roi === 'number', 'roi should be number');
      assert.ok(typeof data.liquidationPrice === 'number', 'liquidationPrice should be number');
    });
  });

  describe('GET /api/data', () => {
    it('should return valid market data response', async () => {
      const data = await fetchJSON('/api/data?source=yahoo');
      
      assert.ok(data.m1, 'Should have m1');
      assert.ok(data.m5, 'Should have m5');
      assert.ok(data.m15, 'Should have m15');
      assert.ok(data.h1, 'Should have h1');
      assert.ok(typeof data.krwUsd === 'number', 'krwUsd should be number');
      assert.ok(typeof data.serverTime === 'number', 'serverTime should be number');
      
      // Check timeframe structure
      for (const tf of ['m1', 'm5', 'm15', 'h1']) {
        const tfData = data[tf];
        assert.ok(Array.isArray(tfData.candles), `${tf}.candles should be array`);
        assert.ok(tfData.meta, `${tf}.meta should exist`);
        assert.ok(typeof tfData.meta.price === 'number', `${tf}.meta.price should be number`);
      }
    });
  });
});
