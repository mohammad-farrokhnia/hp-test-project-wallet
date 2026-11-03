import { currencyFromApiCode, currencySpec, CurrencyCode } from './currency';
import { INT64_MAX, Money } from './money';
import { MoneyError } from './money.error';

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const MAX_LENGTH = 40;

const invalid = (message: string) => new MoneyError('INVALID_AMOUNT', message);

function parseDecimal(
  raw: unknown,
  inputScale: number,
  targetScale: number,
): bigint {
  if (typeof raw !== 'string') throw invalid('amount must be a string');
  if (raw.length > MAX_LENGTH) throw invalid('amount is too long');
  const match = DECIMAL.exec(raw);
  if (!match) {
    throw invalid(`"${raw}" is not a plain non-negative decimal number`);
  }
  const [, whole, fraction = ''] = match;
  if (/[1-9]/.test(fraction.slice(inputScale))) {
    throw invalid(
      inputScale === 0
        ? `"${raw}" must be a whole number`
        : `"${raw}" has more than ${inputScale} decimal places`,
    );
  }
  const minor = BigInt(
    whole + fraction.slice(0, inputScale).padEnd(targetScale, '0'),
  );
  if (minor > INT64_MAX) throw invalid('amount is too large');
  return minor;
}

function formatDecimal(minor: bigint, scale: number): string {
  const sign = minor < 0n ? '-' : '';
  const digits = (minor < 0n ? -minor : minor).toString();
  if (scale === 0) return sign + digits;
  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, '');
  return sign + whole + (fraction ? `.${fraction}` : '');
}

/**
 * @function parseApiAmount
 * @description Parses a client amount string into Money. IRT is whole toman and becomes rial; zero decimals such as "1000.0" are accepted.
 * @param apiCurrency - `IRT` or `USDT`
 * @param raw - the amount string
 * @returns the amount in minor units
 * @throws {MoneyError} `INVALID_AMOUNT`, `UNKNOWN_CURRENCY`
 */
export function parseApiAmount(apiCurrency: string, raw: unknown): Money {
  const spec = currencyFromApiCode(apiCurrency);
  return Money.of(
    spec.code,
    parseDecimal(raw, spec.apiInputScale, spec.apiScale),
  );
}

/**
 * @function formatApiAmount
 * @description Formats Money for the client API: IRR as toman, trailing zeros trimmed.
 * @param money - the amount to format
 * @returns the amount string
 */
export function formatApiAmount(money: Money): string {
  return formatDecimal(money.minor, currencySpec(money.currency).apiScale);
}

/**
 * @function apiCurrencyCode
 * @description Client-facing currency code; IRR is shown as IRT.
 * @param money - the amount whose currency to name
 * @returns `IRT` or `USDT`
 */
export function apiCurrencyCode(money: Money): string {
  return currencySpec(money.currency).apiCode;
}

/**
 * @function toProviderAmount
 * @description Formats Money for providers: integer rial, or USDT with up to 6 decimals.
 * @param money - the amount to send
 * @returns the amount string
 * @throws {MoneyError} `INVALID_AMOUNT` if negative
 */
export function toProviderAmount(money: Money): string {
  if (money.isNegative()) throw invalid('cannot send a negative amount');
  return formatDecimal(money.minor, currencySpec(money.currency).providerScale);
}

/**
 * @function parseProviderAmount
 * @description Parses a provider amount. A JSON number is accepted for IRR only, as a safe integer.
 * @param currency - the internal currency code
 * @param raw - the provider's amount value
 * @returns the amount in minor units
 * @throws {MoneyError} `INVALID_AMOUNT`, `UNKNOWN_CURRENCY`
 */
export function parseProviderAmount(
  currency: CurrencyCode,
  raw: unknown,
): Money {
  const { providerScale } = currencySpec(currency);
  if (typeof raw === 'number') {
    if (providerScale !== 0 || !Number.isSafeInteger(raw) || raw < 0) {
      throw invalid(`${currency} amount must be a string or a safe integer`);
    }
    return Money.of(currency, BigInt(raw));
  }
  return Money.of(currency, parseDecimal(raw, providerScale, providerScale));
}
