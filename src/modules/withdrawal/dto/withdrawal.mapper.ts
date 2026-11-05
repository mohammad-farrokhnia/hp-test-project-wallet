import { apiCurrencyCode, formatApiAmount } from '../../../common/money';
import { maskDestination } from '../domain/destination';
import { WithdrawalRecord } from '../repositories/withdrawals.repository';

export interface WithdrawalView {
  readonly withdrawalId: string;
  readonly status: string;
  readonly userId: string;
  readonly currency: string;
  readonly amount: string;
  readonly fee: string;
  readonly destination: string;
  readonly failureReason: string | null;
  readonly returnedAt: string | null;
  readonly returnReason: string | null;
  readonly needsReview: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toWithdrawalView(w: WithdrawalRecord): WithdrawalView {
  return {
    withdrawalId: w.id,
    status: w.status,
    userId: w.userId,
    currency: apiCurrencyCode(w.amount),
    amount: formatApiAmount(w.amount),
    fee: formatApiAmount(w.fee),
    destination: maskDestination(w.destination),
    failureReason: w.failureReason,
    returnedAt: w.returnedAt?.toISOString() ?? null,
    returnReason: w.returnReason,
    needsReview: w.needsReview,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}
