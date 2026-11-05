import { CurrencyCode, Money } from '../../../common/money';

export type DestinationType = 'IBAN' | 'TRC20';

/**
 * What a currency's withdrawals must respect. Policies are data keyed by currency, so a new
 * currency is a new entry here, never a change to the ledger or the request flow.
 */
export interface WithdrawalPolicy {
  readonly currency: CurrencyCode;
  readonly destinationType: DestinationType;
  readonly minimum: Money;
  readonly fee: Money;
  limitAmountRial(amount: Money): bigint;
}

/** The configured numbers the policies are built from (`AppConfig.limits`). */
export interface WithdrawalLimits {
  readonly withdrawMinRial: bigint;
  readonly usdtWithdrawMinMicro: bigint;
  readonly usdtWithdrawFeeMicro: bigint;
}

export type WithdrawalPolicies = Readonly<
  Record<CurrencyCode, WithdrawalPolicy>
>;

/**
 * @function buildPolicies
 * @description The policy per currency from config.
 * - IRR: minimum 100,000 toman, no fee, to an IBAN; counts in full toward the daily limit.
 * - USDT: minimum 10 USDT, a 1 USDT fee slot, to TRC20. Counted as 0 toward the toman daily
 */
export function buildPolicies(limits: WithdrawalLimits): WithdrawalPolicies {
  return {
    IRR: {
      currency: 'IRR',
      destinationType: 'IBAN',
      minimum: Money.rial(limits.withdrawMinRial),
      fee: Money.zero('IRR'),
      limitAmountRial: (amount) => sameCurrency(amount, 'IRR').minor,
    },
    USDT: {
      currency: 'USDT',
      destinationType: 'TRC20',
      minimum: Money.microUsdt(limits.usdtWithdrawMinMicro),
      fee: Money.microUsdt(limits.usdtWithdrawFeeMicro),
      limitAmountRial: (amount) => {
        sameCurrency(amount, 'USDT');
        return 0n;
      },
    },
  };
}

/** The money a withdrawal moves, as the request flow needs it. */
export interface WithdrawalQuote {
  readonly amount: Money;
  readonly fee: Money;
  readonly total: Money;
  readonly limitAmountRial: bigint;
}

export type QuoteResult =
  | { readonly ok: true; readonly quote: WithdrawalQuote }
  | { readonly ok: false; readonly reason: 'BELOW_MINIMUM' };

/**
 * @function quoteWithdrawal
 * @description Applies the policy to a requested amount: the minimum check, then fee, total and the daily-limit share. Pure;
 * the request flow turns `BELOW_MINIMUM` into a 422 before any transaction.
 * @param policy - the currency's policy
 * @param amount - what the destination should receive, in the policy's currency
 * @returns the quote, or why there is none
 */
export function quoteWithdrawal(
  policy: WithdrawalPolicy,
  amount: Money,
): QuoteResult {
  sameCurrency(amount, policy.currency);
  if (amount.lt(policy.minimum)) return { ok: false, reason: 'BELOW_MINIMUM' };
  return {
    ok: true,
    quote: {
      amount,
      fee: policy.fee,
      total: amount.add(policy.fee),
      limitAmountRial: policy.limitAmountRial(amount),
    },
  };
}

function sameCurrency(amount: Money, currency: CurrencyCode): Money {
  if (amount.currency !== currency) {
    throw new Error(`a ${currency} policy got a ${amount.currency} amount`);
  }
  return amount;
}
