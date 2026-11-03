import { createHash } from 'node:crypto';

const SHEBA_PATTERN = /^IR\d{24}$/;

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TRC20_LENGTH = 34;
const TRC20_PAYLOAD_BYTES = 21; // 1 prefix byte + 20 address bytes
const TRC20_CHECKSUM_BYTES = 4;
const TRC20_PREFIX = 0x41;

/** Upper-cases an IBAN and drops spaces and hyphens: "ir06 2960" → "IR062960". */
export function normalizeIban(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

/** Sheba check: `IR` + 24 digits, and the rearranged number is 1 mod 97. */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!SHEBA_PATTERN.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55),
  );

  return BigInt(digits) % 97n === 1n;
}

function decodeBase58(input: string): Buffer | null {
  let value = 0n;
  for (const char of input) {
    const index = BASE58_ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = value * 58n + BigInt(index);
  }
  const hex = value.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  const leadingZeros = input.length - input.replace(/^1+/, '').length;
  return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

/** TRC20 check: 34-char base58check address, payload prefix 0x41, double-SHA256 checksum. */
export function isValidTrc20(input: string): boolean {
  if (input.length !== TRC20_LENGTH) return false;

  const bytes = decodeBase58(input);
  if (bytes?.length !== TRC20_PAYLOAD_BYTES + TRC20_CHECKSUM_BYTES)
    return false;

  const payload = bytes.subarray(0, TRC20_PAYLOAD_BYTES);
  if (payload[0] !== TRC20_PREFIX) return false;

  const checksum = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, TRC20_CHECKSUM_BYTES);
  return checksum.equals(bytes.subarray(TRC20_PAYLOAD_BYTES));
}
