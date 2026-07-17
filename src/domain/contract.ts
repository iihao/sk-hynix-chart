const BINANCE_FEES = {
  maker: 0.0002,
  taker: 0.0005,
} as const;

export type ContractDirection = 'long' | 'short';
export type ContractFeeType = keyof typeof BINANCE_FEES;

export interface ContractParams {
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  positionSize: number;
  direction: ContractDirection;
  feeType?: ContractFeeType;
  fundingRate?: number;
  fundingCount?: number;
}

export interface ContractResult {
  entryPrice: number;
  exitPrice: number;
  leverage: number;
  positionSize: number;
  margin: number;
  quantity: number;
  direction: ContractDirection;
  pnl: number;
  openFee: number;
  closeFee: number;
  totalFee: number;
  fundingPnl: number;
  fundingCost: number;
  netPnl: number;
  roi: number;
  liquidationPrice: number;
  feeType: ContractFeeType;
  feeRate: number;
}

export class ContractValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractValidationError';
  }
}

function requireFinite(value: number, message: string): void {
  if (!Number.isFinite(value)) throw new ContractValidationError(message);
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function calculateContract(params: ContractParams): ContractResult {
  const {
    entryPrice,
    exitPrice,
    leverage,
    positionSize,
    direction,
    feeType = 'taker',
    fundingRate = 0,
    fundingCount = 0,
  } = params;

  requireFinite(entryPrice, '开仓价格必须为有限数字');
  requireFinite(exitPrice, '平仓价格必须为有限数字');
  requireFinite(leverage, '杠杆倍数必须为有限数字');
  requireFinite(positionSize, '仓位大小必须为有限数字');
  requireFinite(fundingRate, '资金费率必须为有限数字');
  requireFinite(fundingCount, '资金费次数必须为有限数字');

  if (entryPrice <= 0) throw new ContractValidationError('开仓价格必须大于0');
  if (exitPrice <= 0) throw new ContractValidationError('平仓价格必须大于0');
  if (leverage < 1 || leverage > 125) throw new ContractValidationError('杠杆倍数须在1-125之间');
  if (positionSize <= 0) throw new ContractValidationError('仓位大小必须大于0');
  if (!Number.isInteger(fundingCount) || fundingCount < 0) {
    throw new ContractValidationError('资金费次数必须为非负整数');
  }
  if (direction !== 'long' && direction !== 'short') {
    throw new ContractValidationError('方向须为 long 或 short');
  }
  if (feeType !== 'maker' && feeType !== 'taker') {
    throw new ContractValidationError('手续费类型须为 maker 或 taker');
  }

  const fee = BINANCE_FEES[feeType];
  const margin = positionSize / leverage;
  const quantity = positionSize / entryPrice;
  const pnl = direction === 'long'
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
  const openFee = positionSize * fee;
  const closeFee = quantity * exitPrice * fee;
  const totalFee = openFee + closeFee;
  const directionSign = direction === 'long' ? -1 : 1;
  const fundingPnl = positionSize * fundingRate * fundingCount * directionSign;
  const fundingCost = Math.max(0, -fundingPnl);
  const netPnl = pnl - totalFee + fundingPnl;
  const roi = netPnl / margin * 100;
  const maintenanceMarginRate = 0.004;
  const liquidationPrice = direction === 'long'
    ? entryPrice * (1 - 1 / leverage + maintenanceMarginRate)
    : entryPrice * (1 + 1 / leverage - maintenanceMarginRate);

  return {
    entryPrice,
    exitPrice,
    leverage,
    positionSize,
    margin: round(margin),
    quantity: round(quantity, 6),
    direction,
    pnl: round(pnl),
    openFee: round(openFee),
    closeFee: round(closeFee),
    totalFee: round(totalFee),
    fundingPnl: round(fundingPnl),
    fundingCost: round(fundingCost),
    netPnl: round(netPnl),
    roi: round(roi),
    liquidationPrice: round(liquidationPrice),
    feeType,
    feeRate: fee,
  };
}
