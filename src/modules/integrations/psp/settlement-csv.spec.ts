import {
  DEPOSIT_TYPE,
  parseSettlement,
  SETTLEMENT_HEADER,
  SettlementFormatError,
} from './settlement-csv';

/**
 * A real file from `hamtapay/t103-simulator:1.0` (evidence PSP-12): three payments of ours were verified (one row is repeated, with the same
 * row number), one more row is not ours, and each row is written a different way: padded to 13 digits, padded with spaces, bare;
 * Persian or Latin digits; `٬` or `,` as the thousands separator.
 */
const REAL =
  '\uFEFFردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح\r\n1,۱۴۰۵/۰۸/۱۵,0003005946226,واریز درگاه,"۱٬۰۰۰٬۰۰۰",پرداخت اینترنتی A07fc73e0d09163437\r\n2,1405/08/15, 2927489111 ,واریز درگاه,"10,000",پرداخت اینترنتی A06286f2ded96cf6c5\r\n3,1405/08/15,8239046895,واریز درگاه,"۳٬۰۰۰٬۰۰۰",پرداخت اینترنتی A0823cafa6e85ae5c9\r\n3,1405/08/15,8239046895,واریز درگاه,"۳٬۰۰۰٬۰۰۰",پرداخت اینترنتی A0823cafa6e85ae5c9\r\n4,1405/08/15,0008297653641,واریز درگاه,"2,600,000",پرداخت اینترنتی نامشخص\r\n';

const HEADER = SETTLEMENT_HEADER.join(',');
const row = (cells: (string | number)[]) => cells.join(',');
const file = (...rows: string[]) => [HEADER, ...rows].join('\r\n') + '\r\n';
const good = row([
  1,
  '1405/08/15',
  '0001234567890',
  DEPOSIT_TYPE,
  '"1,000,000"',
  'x',
]);

describe('parseSettlement: the real file', () => {
  const parsed = parseSettlement(REAL);

  it('reads every row, whatever way it is written', () => {
    expect(parsed.unreadable).toEqual([]);
    expect(
      parsed.rows.map((r) => [r.rowNumber, r.reference, r.amountRial]),
    ).toEqual([
      ['1', '3005946226', 1_000_000n],
      ['2', '2927489111', 10_000n],
      ['3', '8239046895', 3_000_000n],
      ['3', '8239046895', 3_000_000n],
      ['4', '8297653641', 2_600_000n],
    ]);
  });

  it('turns the zero-padded, space-padded and bare references into one comparable form', () => {
    expect(parsed.rows[0].referenceRaw).toBe('0003005946226');
    expect(parsed.rows[1].referenceRaw).toBe(' 2927489111 ');
    expect(parsed.rows[2].referenceRaw).toBe('8239046895');
    expect(parsed.rows.every((r) => /^[1-9]\d*$/.test(r.reference))).toBe(true);
  });

  it('reads Persian and Latin digits alike, and both thousands separators', () => {
    expect(parsed.rows.map((r) => r.jalaliDate)).toEqual(
      Array(5).fill('1405/08/15'),
    );
    expect(parsed.rows[0].amountRial).toBe(1_000_000n);
    expect(parsed.rows[4].amountRial).toBe(2_600_000n);
  });

  it('keeps the description: our payments carry their PSP token, the row that is not ours says unknown', () => {
    expect(parsed.rows[0].description).toMatch(/A07fc73e0d09163437$/);
    expect(parsed.rows[4].description).toMatch(/نامشخص$/);
  });

  it('numbers the lines from the header, so a problem can be found in the file', () => {
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 3, 4, 5, 6]);
  });
});

describe('parseSettlement: forms of the same file', () => {
  it('does not need the BOM, CRLF or the final newline', () => {
    const csv = [HEADER, good].join('\n');
    expect(parseSettlement(csv).rows).toHaveLength(1);
    expect(parseSettlement('\uFEFF' + csv).rows).toHaveLength(1);
    expect(parseSettlement(file(good)).rows).toHaveLength(1);
  });

  it('skips blank lines', () => {
    expect(
      parseSettlement(`${HEADER}\r\n\r\n${good}\r\n\r\n\r\n`).rows,
    ).toHaveLength(1);
  });

  it('reads a quoted description that holds a comma, a doubled quote and a line break', () => {
    const csv = file(
      row([1, '1405/08/15', '55', DEPOSIT_TYPE, '"1,000"', '"a, ""b""\r\nc"']),
      row([2, '1405/08/15', '56', DEPOSIT_TYPE, '"2,000"', 'next']),
    );
    const { rows, unreadable } = parseSettlement(csv);
    expect(unreadable).toEqual([]);
    expect(rows[0].description).toBe('a, "b"\r\nc');
    expect(rows[1].line).toBe(4);
    expect(rows[1].reference).toBe('56');
  });

  it('reads Arabic-Indic digits, a zero-width non-joiner in the reference and an Arabic comma in the amount', () => {
    const csv = file(
      row(['١', '١٤٠٥/٠٨/١٥', '٠٠٥\u200c٦', DEPOSIT_TYPE, '"١،٠٠٠"', 'x']),
    );
    const [r] = parseSettlement(csv).rows;
    expect(r.reference).toBe('56');
    expect(r.amountRial).toBe(1000n);
    expect(r.jalaliDate).toBe('1405/08/15');
  });

  it('reads the largest amount a 64-bit column holds, and refuses one more', () => {
    const max = '9223372036854775807';
    const ok = parseSettlement(
      file(row([1, '1405/08/15', '7', DEPOSIT_TYPE, `"${max}"`, 'x'])),
    );
    expect(ok.rows[0].amountRial).toBe(BigInt(max));
    const over = parseSettlement(
      file(
        row([1, '1405/08/15', '7', DEPOSIT_TYPE, '"9223372036854775808"', 'x']),
      ),
    );
    expect(over.rows).toEqual([]);
    expect(over.unreadable[0].reason).toBe('BAD_AMOUNT');
  });
});

describe('parseSettlement: rows it cannot read are reported, never dropped', () => {
  it.each([
    [
      'a missing column',
      row([1, '1405/08/15', '5', DEPOSIT_TYPE, '"1,000"']),
      'WRONG_COLUMN_COUNT',
    ],
    [
      'an extra column',
      row([1, '1405/08/15', '5', DEPOSIT_TYPE, '"1,000"', 'x', 'y']),
      'WRONG_COLUMN_COUNT',
    ],
    [
      'another transaction type',
      row([1, '1405/08/15', '5', 'برگشت', '"1,000"', 'x']),
      'UNKNOWN_TYPE',
    ],
    [
      'an empty reference',
      row([1, '1405/08/15', '', DEPOSIT_TYPE, '"1,000"', 'x']),
      'BAD_REFERENCE',
    ],
    [
      'a reference of zeros',
      row([1, '1405/08/15', '0000', DEPOSIT_TYPE, '"1,000"', 'x']),
      'BAD_REFERENCE',
    ],
    [
      'a reference with letters',
      row([1, '1405/08/15', '12AB', DEPOSIT_TYPE, '"1,000"', 'x']),
      'BAD_REFERENCE',
    ],
    [
      'a reference with a hyphen',
      row([1, '1405/08/15', '12-34', DEPOSIT_TYPE, '"1,000"', 'x']),
      'BAD_REFERENCE',
    ],
    [
      'a zero amount',
      row([1, '1405/08/15', '5', DEPOSIT_TYPE, '0', 'x']),
      'BAD_AMOUNT',
    ],
    [
      'a negative amount',
      row([1, '1405/08/15', '5', DEPOSIT_TYPE, '-100', 'x']),
      'BAD_AMOUNT',
    ],
    [
      'a decimal amount',
      row([1, '1405/08/15', '5', DEPOSIT_TYPE, '"1000.5"', 'x']),
      'BAD_AMOUNT',
    ],
    [
      'an amount with letters',
      row([1, '1405/08/15', '5', DEPOSIT_TYPE, 'abc', 'x']),
      'BAD_AMOUNT',
    ],
    [
      'an empty amount',
      row([1, '1405/08/15', '5', DEPOSIT_TYPE, '', 'x']),
      'BAD_AMOUNT',
    ],
    [
      'a date that is not a date',
      row([1, 'NaN/NaN/NaN', '5', DEPOSIT_TYPE, '"1,000"', 'x']),
      'BAD_DATE',
    ],
    [
      'a date in another form',
      row([1, '1405-08-15', '5', DEPOSIT_TYPE, '"1,000"', 'x']),
      'BAD_DATE',
    ],
  ])('%s → %s', (_name, bad, reason) => {
    const { rows, unreadable } = parseSettlement(file(good, bad));
    expect(rows).toHaveLength(1);
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toMatchObject({ line: 3, reason });
    expect(unreadable[0].raw.length).toBeGreaterThan(0);
  });

  it('keeps going after an unreadable row: the rows around it are still read', () => {
    const { rows, unreadable } = parseSettlement(
      file(
        good,
        'garbage',
        row([2, '1405/08/15', '6', DEPOSIT_TYPE, '"2,000"', 'x']),
      ),
    );
    expect(rows.map((r) => r.reference)).toEqual(['1234567890', '6']);
    expect(unreadable).toHaveLength(1);
  });
});

describe('parseSettlement: a file that is not a settlement file', () => {
  it.each([
    ['an empty file', ''],
    ['only a BOM', '\uFEFF'],
    ['a JSON error body', '{"code":-404,"message":"not found"}'],
    ['an HTML page', '<html><body>502 Bad Gateway</body></html>'],
    ['another header', 'a,b,c,d,e,f\r\n1,2,3,4,5,6\r\n'],
    ['a header with a column missing', SETTLEMENT_HEADER.slice(0, 5).join(',')],
    [
      'the columns in another order',
      [...SETTLEMENT_HEADER].reverse().join(','),
    ],
  ])('%s is refused whole', (_name, text) => {
    expect(() => parseSettlement(text)).toThrow(SettlementFormatError);
  });

  it('accepts a header-only file: a day with nothing in it', () => {
    expect(parseSettlement(`${HEADER}\r\n`)).toEqual({
      rows: [],
      unreadable: [],
    });
  });
});
