export type PaperDirection = 'long' | 'short';
export type PaperFillType = 'OPEN' | 'CLOSE' | 'TAKE_PROFIT' | 'STOP_LOSS' | 'CLOSE_ALL';

const TAKER_FEE_RATE = 0.0005;

export interface PaperAccountState {
  initialBalance: number;
  availableBalance: number;
  realizedPnl: number;
}

export interface PaperPosition {
  id?: number;
  direction: PaperDirection;
  entryPrice: number;
  quantity: number;
  leverage: number;
  margin: number;
  notional: number;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
  openedAt: number;
}

export interface PaperFill {
  positionId?: number | null;
  type: PaperFillType;
  direction: PaperDirection;
  price: number;
  quantity: number;
  notional: number;
  fee: number;
  realizedPnl: number;
  balanceAfter: number;
  reason: string;
  createdAt: number;
}

export interface OpenPaperOrderInput {
  direction: PaperDirection;
  entryPrice: number;
  notional: number;
  leverage: number;
  takeProfitPrice?: number | null;
  stopLossPrice?: number | null;
  now: number;
}

export interface ClosePaperPositionInput {
  exitPrice: number;
  now: number;
  type: Exclude<PaperFillType, 'OPEN'>;
}

export class PaperTradeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaperTradeValidationError';
  }
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function requireFinite(value: number, message: string): void {
  if (!Number.isFinite(value)) throw new PaperTradeValidationError(message);
}

function validateDirection(direction: PaperDirection): void {
  if (direction !== 'long' && direction !== 'short') {
    throw new PaperTradeValidationError('方向须为 long 或 short');
  }
}

function signedPnl(direction: PaperDirection, entryPrice: number, exitPrice: number, quantity: number): number {
  return direction === 'long'
    ? (exitPrice - entryPrice) * quantity
    : (entryPrice - exitPrice) * quantity;
}

export function markPaperPosition(position: PaperPosition, markPrice: number) {
  requireFinite(markPrice, '标记价格必须为有限数字');
  if (markPrice <= 0) throw new PaperTradeValidationError('标记价格必须大于0');
  const currentNotional = position.quantity * markPrice;
  const unrealizedPnl = signedPnl(position.direction, position.entryPrice, markPrice, position.quantity);
  return {
    ...position,
    markPrice: round(markPrice, 4),
    currentNotional: round(currentNotional),
    unrealizedPnl: round(unrealizedPnl),
    roe: round((unrealizedPnl / position.margin) * 100),
  };
}

export function openPaperPosition(account: PaperAccountState, input: OpenPaperOrderInput) {
  validateDirection(input.direction);
  requireFinite(account.availableBalance, '可用余额必须为有限数字');
  requireFinite(account.realizedPnl, '已实现盈亏必须为有限数字');
  requireFinite(input.entryPrice, '开仓价格必须为有限数字');
  requireFinite(input.notional, '仓位名义价值必须为有限数字');
  requireFinite(input.leverage, '杠杆必须为有限数字');
  if (input.entryPrice <= 0) throw new PaperTradeValidationError('开仓价格必须大于0');
  if (input.notional <= 0) throw new PaperTradeValidationError('仓位名义价值必须大于0');
  if (input.leverage < 1 || input.leverage > 125) throw new PaperTradeValidationError('杠杆须在1-125之间');

  const margin = input.notional / input.leverage;
  const fee = input.notional * TAKER_FEE_RATE;
  const required = margin + fee;
  if (account.availableBalance < required) {
    throw new PaperTradeValidationError('可用余额不足以覆盖保证金和开仓手续费');
  }

  const nextAccount = {
    ...account,
    availableBalance: round(account.availableBalance - required),
    realizedPnl: round(account.realizedPnl - fee),
  };
  const position: PaperPosition = {
    direction: input.direction,
    entryPrice: round(input.entryPrice, 4),
    quantity: round(input.notional / input.entryPrice, 8),
    leverage: Math.round(input.leverage),
    margin: round(margin),
    notional: round(input.notional),
    takeProfitPrice: input.takeProfitPrice || null,
    stopLossPrice: input.stopLossPrice || null,
    openedAt: input.now,
  };
  const fill: PaperFill = {
    type: 'OPEN',
    direction: input.direction,
    price: position.entryPrice,
    quantity: position.quantity,
    notional: position.notional,
    fee: round(fee),
    realizedPnl: round(-fee),
    balanceAfter: nextAccount.availableBalance,
    reason: '模拟开仓',
    createdAt: input.now,
  };
  return { account: nextAccount, position, fill };
}

export function closePaperPosition(
  account: PaperAccountState,
  position: PaperPosition,
  input: ClosePaperPositionInput,
) {
  requireFinite(account.availableBalance, '可用余额必须为有限数字');
  requireFinite(input.exitPrice, '平仓价格必须为有限数字');
  if (input.exitPrice <= 0) throw new PaperTradeValidationError('平仓价格必须大于0');

  const gross = signedPnl(position.direction, position.entryPrice, input.exitPrice, position.quantity);
  const exitNotional = position.quantity * input.exitPrice;
  const fee = exitNotional * TAKER_FEE_RATE;
  const realizedPnl = gross - fee;
  const nextAccount = {
    ...account,
    availableBalance: round(account.availableBalance + position.margin + realizedPnl),
    realizedPnl: round(account.realizedPnl + realizedPnl),
  };
  const reasonByType: Record<Exclude<PaperFillType, 'OPEN'>, string> = {
    CLOSE: '手动平仓',
    CLOSE_ALL: '一键清仓',
    TAKE_PROFIT: '止盈触发',
    STOP_LOSS: '止损触发',
  };

  const fill: PaperFill = {
    positionId: position.id ?? null,
    type: input.type,
    direction: position.direction,
    price: round(input.exitPrice, 4),
    quantity: position.quantity,
    notional: round(exitNotional),
    fee: round(fee),
    realizedPnl: round(realizedPnl),
    balanceAfter: nextAccount.availableBalance,
    reason: reasonByType[input.type],
    createdAt: input.now,
  };
  return { account: nextAccount, fill };
}

export function findTriggeredExit(position: PaperPosition, markPrice: number): { type: 'TAKE_PROFIT' | 'STOP_LOSS'; price: number } | null {
  requireFinite(markPrice, '标记价格必须为有限数字');
  const tp = position.takeProfitPrice;
  const sl = position.stopLossPrice;
  if (position.direction === 'long') {
    if (typeof tp === 'number' && tp > 0 && markPrice >= tp) return { type: 'TAKE_PROFIT', price: tp };
    if (typeof sl === 'number' && sl > 0 && markPrice <= sl) return { type: 'STOP_LOSS', price: sl };
  } else {
    if (typeof tp === 'number' && tp > 0 && markPrice <= tp) return { type: 'TAKE_PROFIT', price: tp };
    if (typeof sl === 'number' && sl > 0 && markPrice >= sl) return { type: 'STOP_LOSS', price: sl };
  }
  return null;
}

export function summarizePaperAccount(
  account: PaperAccountState,
  positions: PaperPosition[],
  markPrice: number,
) {
  const markedPositions = positions.map((position) => markPaperPosition(position, markPrice));
  const marginUsed = markedPositions.reduce((sum, position) => sum + position.margin, 0);
  const unrealizedPnl = markedPositions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const equity = account.availableBalance + marginUsed + unrealizedPnl;
  return {
    account: {
      ...account,
      equity: round(equity),
      marginUsed: round(marginUsed),
      unrealizedPnl: round(unrealizedPnl),
      totalPnl: round(equity - account.initialBalance),
      totalReturnPct: account.initialBalance > 0 ? round(((equity - account.initialBalance) / account.initialBalance) * 100) : 0,
    },
    positions: markedPositions,
    markPrice: round(markPrice, 4),
  };
}
