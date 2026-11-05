import { CurrencyCode, Money, MoneyError } from '../../../common/money';

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
  readonly limitRateRialPerUsdt: bigint | null;
  limitAmountRial(amount: Money): bigint;
}

/** The configured numbers the policies are built from (`AppConfig.limits`). */
export interface WithdrawalLimits {
  readonly withdrawMinRial: bigint;
  readonly usdtWithdrawMinMicro: bigint;
  readonly usdtWithdrawFeeMicro: bigint;
  readonly usdtReferenceRateRial: bigint;
}

const MICRO_PER_USDT = 1_000_000n;

/** Division that never rounds down: a USDT dust amount still counts at least 1 rial. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export type WithdrawalPolicies = Readonly<
  Record<CurrencyCode, WithdrawalPolicy>
>;

/**
 * @function buildPolicies
 * @description The policy per currency from config.
 * - IRR: minimum 100,000 toman, no fee, to an IBAN; counts in full toward the daily limit.
 * - USDT: minimum 10 USDT, a 1 USDT fee slot, to TRC20. Counts toward the toman daily limit at the configured reference rate, rounded up;
 *   the fee does not count. The rate is part of the quote, so it can be saved on the withdrawal row.
 */
export function buildPolicies(limits: WithdrawalLimits): WithdrawalPolicies {
  return {
    IRR: {
      currency: 'IRR',
      destinationType: 'IBAN',
      minimum: Money.rial(limits.withdrawMinRial),
      fee: Money.zero('IRR'),
      limitRateRialPerUsdt: null,
      limitAmountRial: (amount) => sameCurrency(amount, 'IRR').minor,
    },
    USDT: {
      currency: 'USDT',
      destinationType: 'TRC20',
      minimum: Money.microUsdt(limits.usdtWithdrawMinMicro),
      fee: Money.microUsdt(limits.usdtWithdrawFeeMicro),
      limitRateRialPerUsdt: limits.usdtReferenceRateRial,
      limitAmountRial: (amount) =>
        ceilDiv(
          sameCurrency(amount, 'USDT').minor * limits.usdtReferenceRateRial,
          MICRO_PER_USDT,
        ),
    },
  };
}

/** The money a withdrawal moves, as the request flow needs it. */
export interface WithdrawalQuote {
  readonly amount: Money;
  readonly fee: Money;
  readonly total: Money;
  readonly limitAmountRial: bigint;
  /** The reference rate behind `limitAmountRial`, snapshotted on the withdrawal; `null` for IRR. */
  readonly limitRateRialPerUsdt: bigint | null;
}

export type QuoteResult =
  | { readonly ok: true; readonly quote: WithdrawalQuote }
  | { readonly ok: false; readonly reason: 'BELOW_MINIMUM' | 'TOO_LARGE' };

/**
 * @function quoteWithdrawal
 * @description Applies the policy to a requested amount: the minimum check, then fee, total and the daily-limit share. Pure;
 * the request flow turns `BELOW_MINIMUM` into a 422 and `TOO_LARGE` (amount + fee does not fit a 64-bit balance) into a 400 before any transaction.
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
  const total = totalOf(amount, policy.fee);
  if (total === null) return { ok: false, reason: 'TOO_LARGE' };
  return {
    ok: true,
    quote: {
      amount,
      fee: policy.fee,
      total,
      limitAmountRial: policy.limitAmountRial(amount),
      limitRateRialPerUsdt: policy.limitRateRialPerUsdt,
    },
  };
}

/** amount + fee, or `null` when the sum does not fit the ledger's 64-bit balances. */
function totalOf(amount: Money, fee: Money): Money | null {
  try {
    return amount.add(fee);
  } catch (err) {
    if (err instanceof MoneyError && err.code === 'OUT_OF_RANGE') return null;
    throw err;
  }
}

function sameCurrency(amount: Money, currency: CurrencyCode): Money {
  if (amount.currency !== currency) {
    throw new Error(`a ${currency} policy got a ${amount.currency} amount`);
  }
  return amount;
}
