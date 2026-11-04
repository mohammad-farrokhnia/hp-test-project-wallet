import { Injectable } from '@nestjs/common';
import { Money } from '../../../common/money';
import { Tx } from '../../../database/transaction-runner';

/** Amount + fee of one user's non-final withdrawals in one currency. */
export interface OpenWithdrawalTotal {
  readonly userId: string;
  readonly amount: Money;
}

/**
 * @description Σ (amount + fee) of non-final withdrawals per user and currency;
 */
export interface OpenWithdrawalTotals {
  openTotals(tx: Tx): Promise<OpenWithdrawalTotal[]>;
}

export const OPEN_WITHDRAWAL_TOTALS = Symbol('OPEN_WITHDRAWAL_TOTALS');

/**
 * @class NoOpenWithdrawals
 * @description there are no withdrawals, so nothing may be frozen and any FROZEN balance is reported.
 */
@Injectable()
export class NoOpenWithdrawals implements OpenWithdrawalTotals {
  openTotals(): Promise<OpenWithdrawalTotal[]> {
    return Promise.resolve([]);
  }
}
