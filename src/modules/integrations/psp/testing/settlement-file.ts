import { jalaliDate } from '../../../../common/time';
import { DEPOSIT_TYPE, SETTLEMENT_HEADER } from '../settlement-csv';

export interface FileRow {
  readonly reference: string;
  readonly amountRial: bigint;
  readonly token?: string;
}

const char = (code: number) => String.fromCharCode(code);
const persian = (digits: string) =>
  digits.replace(/\d/g, (d) => char(0x06f0 + parseInt(d, 10)));
const grouped = (n: bigint, separator: string) =>
  n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, separator);

/** The ways the simulator wrote its rows, in the order it used them: row `i` is written in style `i mod 4`. */
const STYLES: readonly {
  reference: (ref: string) => string;
  persianDate: boolean;
  amount: (n: bigint) => string;
}[] = [
  {
    reference: (r) => r.padStart(13, '0'),
    persianDate: true,
    amount: (n) => persian(grouped(n, char(0x066c))),
  },
  {
    reference: (r) => ` ${r} `,
    persianDate: false,
    amount: (n) => grouped(n, ','),
  },
  {
    reference: (r) => r,
    persianDate: false,
    amount: (n) => persian(grouped(n, char(0x066c))),
  },
  {
    reference: (r) => r.padStart(13, '0'),
    persianDate: false,
    amount: (n) => grouped(n, ','),
  },
];

const PAYMENT = 'پرداخت اینترنتی';
const UNKNOWN = 'نامشخص';

/**
 * @function settlementFile
 * @description A settlement file for a Tehran day as the PSP writes it: a UTF-8 BOM, CRLF, the Persian header, and rows in the four styles the simulator alternates
 * (13-digit zero padding, space padding, bare; Persian or Latin digits; `٬` or `,`).
 * @param day - the Tehran day, `YYYY-MM-DD`
 * @param rows - what to list, in order
 * @returns the file's text
 */
export function settlementFile(day: string, rows: readonly FileRow[]): string {
  const date = jalaliDate(day);
  const lines = rows.map((r, i) => {
    const style = STYLES[i % STYLES.length];
    return [
      String(i + 1),
      style.persianDate ? persian(date) : date,
      style.reference(r.reference),
      DEPOSIT_TYPE,
      `"${style.amount(r.amountRial)}"`,
      `${PAYMENT} ${r.token ?? UNKNOWN}`,
    ].join(',');
  });
  return (
    char(0xfeff) + [SETTLEMENT_HEADER.join(','), ...lines].join('\r\n') + '\r\n'
  );
}

/**
 * @function withLines
 * @description Replaces or appends raw lines in a file, to seed what the builder would never write: a repeated row, a broken row, a row dated another day.
 * @param file - a file from `settlementFile`
 * @param extra - raw lines to add at the end
 */
export function withLines(file: string, ...extra: string[]): string {
  return file + extra.join('\r\n') + (extra.length > 0 ? '\r\n' : '');
}
