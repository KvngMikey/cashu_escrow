import { EscrowError } from '../errors.ts';
import { MAX_SATS } from '../primitives.ts';

export const REFUND_FEE_MODES = ['network_only', 'full'] as const;
export type RefundFeeMode = (typeof REFUND_FEE_MODES)[number];
export type FeeOperation = 'settlement' | 'refund';

export type FeeInput = {
  gross: number;
  bps: number;
  minFee: number;
  enabled: boolean;
  networkCost: number;
  operation: FeeOperation;
  refundFeeMode: RefundFeeMode;
};

export type FeeBreakdown = {
  gross: number;
  operatorFee: number;
  networkCost: number;
  payout: number;
};

/** The only fee arithmetic used by quotes and custody actions. */
export function computeFees(input: FeeInput): FeeBreakdown {
  assertPositiveSats(input.gross, 'gross amount');
  assertNonNegativeSats(input.minFee, 'minimum fee');
  assertNonNegativeSats(input.networkCost, 'network cost');
  if (!Number.isInteger(input.bps) || input.bps < 0 || input.bps > 10_000) {
    throw new EscrowError('content_invalid', 'fee rate is invalid');
  }

  const percentageFee = Number(
    (BigInt(input.gross) * BigInt(input.bps) + 9_999n) / 10_000n
  );
  const chargeOperatorFee =
    input.enabled &&
    (input.operation === 'settlement' || input.refundFeeMode === 'full');
  const operatorFee = chargeOperatorFee
    ? Math.max(percentageFee, input.minFee)
    : 0;
  const payout = input.gross - operatorFee - input.networkCost;

  if (payout <= 0) {
    throw new EscrowError('content_invalid', 'fees exhaust the gross amount');
  }

  return {
    gross: input.gross,
    operatorFee,
    networkCost: input.networkCost,
    payout,
  };
}

function assertPositiveSats(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_SATS) {
    throw new EscrowError('content_invalid', `${label} is invalid`);
  }
}

function assertNonNegativeSats(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SATS) {
    throw new EscrowError('content_invalid', `${label} is invalid`);
  }
}
