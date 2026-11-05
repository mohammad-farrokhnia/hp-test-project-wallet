import { maskDestination, parseDestination } from './destination';

const IBAN = 'IR330566736841214070501510';
const TRC20 = 'TLiap5woBhMmk8PUrsTtQAdJxRbZ1y79bP';

describe('parseDestination', () => {
  it.each([
    ['a valid IBAN', IBAN],
    ['spaced lowercase', 'ir33 0566 7368 4121 4070 5015 10'],
    ['hyphenated', 'IR33-0566-7368-4121-4070-5015-10'],
  ])('accepts %s for IBAN and stores it normalised', (_c, raw) => {
    expect(parseDestination('IBAN', raw)).toBe(IBAN);
  });

  it('accepts a valid TRC20 address as sent, trimmed', () => {
    expect(parseDestination('TRC20', ` ${TRC20} `)).toBe(TRC20);
  });

  it.each([
    ['IBAN', 'IR330566736841214070501511'], // mod-97 fails
    ['IBAN', TRC20], // wrong type for the currency
    ['TRC20', IBAN],
    ['TRC20', 'TGk8wmEDnsZEmDnwdfoi6APtDsQ2ypaZpx'],
  ] as const)('refuses %s %s', (type, raw) => {
    expect(parseDestination(type, raw)).toBeNull();
  });
});

describe('maskDestination', () => {
  it('shows only the first and last 4 characters', () => {
    expect(maskDestination(IBAN)).toBe('IR33******************1510');
    expect(maskDestination(TRC20)).toBe(`TLia${'*'.repeat(26)}79bP`);
  });

  it('masks everything when there is too little to hide', () => {
    expect(maskDestination('abc')).toBe('***');
  });
});
