import { formatApiAmount } from '../../../common/money';
import { DepositRecord } from '../repositories/deposits.repository';

export interface DepositView {
  readonly depositId: string;
  readonly status: string;
  readonly userId: string;
  readonly currency: 'IRT';
  readonly amount: string;
  readonly creditedAmount: string | null;
  readonly paymentUrl: string | null;
  readonly failureReason: string | null;
  readonly needsReview: boolean;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The API shape of a deposit: amounts in toman strings, timestamps in ISO 8601. */
export function toDepositView(d: DepositRecord): DepositView {
  return {
    depositId: d.id,
    status: d.status,
    userId: d.userId,
    currency: 'IRT',
    amount: formatApiAmount(d.amount),
    creditedAmount: d.creditedAmount ? formatApiAmount(d.creditedAmount) : null,
    paymentUrl: d.paymentUrl,
    failureReason: d.failureReason,
    needsReview: d.needsReview,
    expiresAt: d.expiresAt.toISOString(),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}
