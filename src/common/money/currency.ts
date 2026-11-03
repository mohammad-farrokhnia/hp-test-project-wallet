import { MoneyError } from './money.error';

export type CurrencyCode = 'IRR' | 'USDT';
export type ApiCurrencyCode = 'IRT' | 'USDT';

export interface CurrencySpec {
  readonly code: CurrencyCode;
  readonly apiCode: ApiCurrencyCode;
  readonly apiScale: number;
  readonly apiInputScale: number;
  readonly providerScale: number;
}

export const CURRENCIES: Readonly<Record<CurrencyCode, CurrencySpec>> =
  Object.freeze({
    IRR: Object.freeze({
      code: 'IRR',
      apiCode: 'IRT',
      apiScale: 1,
      apiInputScale: 0,
      providerScale: 0,
    }),
    USDT: Object.freeze({
      code: 'USDT',
      apiCode: 'USDT',
      apiScale: 6,
      apiInputScale: 6,
      providerScale: 6,
    }),
  });

/**
 * @function currencySpec
 * @description Looks up a currency by its internal code.
 * @param code - `IRR` or `USDT`
 * @returns the currency spec
 * @throws {MoneyError} `UNKNOWN_CURRENCY`
 */
export function currencySpec(code: string): CurrencySpec {
  if (!Object.hasOwn(CURRENCIES, code)) {
    throw new MoneyError('UNKNOWN_CURRENCY', `unknown currency "${code}"`);
  }
  return CURRENCIES[code as CurrencyCode];
}

/**
 * @function currencyFromApiCode
 * @description Looks up a currency by its client-facing code.
 * @param apiCode - `IRT` or `USDT`
 * @returns the currency spec
 * @throws {MoneyError} `UNKNOWN_CURRENCY`
 */
export function currencyFromApiCode(apiCode: string): CurrencySpec {
  const spec = Object.values(CURRENCIES).find((c) => c.apiCode === apiCode);
  if (!spec) {
    throw new MoneyError('UNKNOWN_CURRENCY', `unknown currency "${apiCode}"`);
  }
  return spec;
}
