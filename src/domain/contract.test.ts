import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateContract, ContractValidationError } from './contract';

const base = {
  entryPrice: 100,
  exitPrice: 110,
  leverage: 10,
  positionSize: 1000,
  direction: 'long' as const,
  feeType: 'taker' as const,
  fundingRate: 0.001,
  fundingCount: 1,
};

describe('calculateContract funding cash flow', () => {
  it('charges longs when funding is positive', () => {
    const result = calculateContract(base);
    assert.equal(result.fundingPnl, -1);
    assert.equal(result.fundingCost, 1);
  });

  it('credits shorts when funding is positive', () => {
    const result = calculateContract({ ...base, direction: 'short' });
    assert.equal(result.fundingPnl, 1);
    assert.equal(result.fundingCost, 0);
  });

  it('credits longs when funding is negative', () => {
    const result = calculateContract({ ...base, fundingRate: -0.001 });
    assert.equal(result.fundingPnl, 1);
    assert.equal(result.fundingCost, 0);
  });

  it('charges shorts when funding is negative', () => {
    const result = calculateContract({ ...base, direction: 'short', fundingRate: -0.001 });
    assert.equal(result.fundingPnl, -1);
    assert.equal(result.fundingCost, 1);
  });

  it('includes received funding in net PnL', () => {
    const withoutFunding = calculateContract({ ...base, direction: 'short', fundingRate: 0 });
    const withFunding = calculateContract({ ...base, direction: 'short' });
    assert.equal(withFunding.netPnl, withoutFunding.netPnl + 1);
  });
});

describe('calculateContract validation', () => {
  for (const [field, value] of [
    ['entryPrice', 0],
    ['exitPrice', Number.NaN],
    ['leverage', 126],
    ['positionSize', Number.POSITIVE_INFINITY],
    ['fundingRate', Number.NaN],
    ['fundingCount', -1],
  ] as const) {
    it(`rejects invalid ${field}`, () => {
      assert.throws(
        () => calculateContract({ ...base, [field]: value }),
        ContractValidationError,
      );
    });
  }
});
