import { isValidIban, isValidTrc20, normalizeIban } from './destination';

const VALID_IBAN = 'IR330566736841214070501510';
const BAD_CHECKSUM_IBAN = 'IR920122265946486861932802'; // provider accepted, later INVALID_IBAN
const VALID_TRC20 = 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP';
const BAD_CHECKSUM_TRC20 = 'TGk8wmEDnsZEmDnwdfoi6APtDsQ2ypaZpx'; // provider paid it (SUCCEEDED)

describe('normalizeIban', () => {
  it.each([
    ['ir33 0566 7368 4121 4070 5015 10', VALID_IBAN],
    ['  ir330566736841214070501510  ', VALID_IBAN],
    ['IR33-0566-7368-4121-4070-5015-10', VALID_IBAN],
    ['IR330566736841214070501510', VALID_IBAN],
    ['', ''],
  ])('normalises "%s"', (input, expected) => {
    expect(normalizeIban(input)).toBe(expected);
  });
});

describe('isValidIban (Sheba, PAY-06)', () => {
  it.each([
    ['canonical', VALID_IBAN],
    ['spaced lowercase', 'ir33 0566 7368 4121 4070 5015 10'],
    ['common documentation example', 'IR062960000000100324200001'],
  ])('accepts a valid IBAN: %s', (_name, input) => {
    expect(isValidIban(input)).toBe(true);
  });

  it.each([
    ['bad checksum', BAD_CHECKSUM_IBAN],
    ['one digit changed', 'IR330566736841214070501511'],
    ['malformed IR123', 'IR123'],
    ['too short by one digit', 'IR33056673684121407050151'],
    ['too long by one digit', 'IR3305667368412140705015100'],
    ['wrong country', 'DE89370400440532013000'],
    ['letters in the digits', 'IR33056673684121407050151X'],
    ['no country prefix', '330566736841214070501510'],
    ['empty', ''],
    ['spaces only', '   '],
  ])('rejects %s', (_name, input) => {
    expect(isValidIban(input)).toBe(false);
  });
});

describe('isValidTrc20 (base58check, PAY-06)', () => {
  it.each([
    ['evidence address', VALID_TRC20],
    ['evidence address 2', 'TQVaE9iCR3ATpw8zbw6SrXU9uK3zjTnrGH'],
    ['USDT contract', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
  ])('accepts a valid address: %s', (_name, input) => {
    expect(isValidTrc20(input)).toBe(true);
  });

  it.each([
    ['broken checksum (paid by the provider)', BAD_CHECKSUM_TRC20],
    ['last character changed', 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bQ'],
    ['too short', 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79b'],
    ['too long', 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bPP'],
    ['character outside base58 (0)', 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y790P'],
    ['character outside base58 (l)', 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bl'],
    ['Ethereum-style address', '0x71C7656EC7ab88b098defB751B7401B5f6d8976F'],
    ['lowercased', VALID_TRC20.toLowerCase()],
    ['surrounding spaces', ` ${VALID_TRC20} `],
    ['empty', ''],
  ])('rejects %s', (_name, input) => {
    expect(isValidTrc20(input)).toBe(false);
  });
});
