import { INT64_MAX } from '../../../common/money';

/** The columns of the PSP's settlement file, in order: row, date, bank tracking number, type, amount (rial), description. */
export const SETTLEMENT_HEADER = [
  'ردیف',
  'تاریخ',
  'شماره پیگیری',
  'نوع تراکنش',
  'مبلغ (ریال)',
  'شرح',
] as const;

/** The only transaction type we reconcile: a payment into the gateway (`واریز درگاه`, "gateway deposit"). */
export const DEPOSIT_TYPE = 'واریز درگاه';

/** A readable row of the settlement file. */
export interface SettlementRow {
  readonly line: number;
  readonly rowNumber: string;
  readonly jalaliDate: string;
  readonly reference: string;
  readonly referenceRaw: string;
  readonly amountRial: bigint;
  readonly description: string;
}

/** A row that could not be read, kept so that nothing in the file is silently ignored. */
export interface UnreadableRow {
  readonly line: number;
  readonly reason:
    | 'WRONG_COLUMN_COUNT'
    | 'UNKNOWN_TYPE'
    | 'BAD_REFERENCE'
    | 'BAD_AMOUNT'
    | 'BAD_DATE';
  readonly raw: string;
}

export interface ParsedSettlement {
  readonly rows: readonly SettlementRow[];
  readonly unreadable: readonly UnreadableRow[];
}

/** The file is not a settlement file we understand at all (wrong header): nothing in it can be trusted. */
export class SettlementFormatError extends Error {}

const NOISE = /[\s\u200c\u200e\u200f\u00a0]+/g;
const THOUSANDS = /[,\u066c\u060c]/g;

/** Persian (U+06F0..) and Arabic-Indic (U+0660..) digits to Latin ones. */
function latin(text: string): string {
  return text
    .replace(/[\u06f0-\u06f9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}

/** RFC 4180 records: quoted cells may hold commas, doubled quotes and line breaks. Each record keeps the line it starts on. */
function records(text: string): { line: number; cells: string[] }[] {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let start = 1;
  const endCell = () => {
    cells.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    if (!(cells.length === 1 && cells[0].trim() === '')) {
      out.push({ line: start, cells });
    }
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      endCell();
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      start = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) endRecord();
  return out;
}

function readRow(line: number, cells: string[]): SettlementRow | UnreadableRow {
  const raw = cells.join(',');
  const unreadable = (reason: UnreadableRow['reason']): UnreadableRow => ({
    line,
    reason,
    raw,
  });
  if (cells.length !== SETTLEMENT_HEADER.length) {
    return unreadable('WRONG_COLUMN_COUNT');
  }
  const [rowNumber, date, referenceCell, type, amountCell, description] = cells;

  if (type.trim() !== DEPOSIT_TYPE) return unreadable('UNKNOWN_TYPE');

  const referenceRaw = referenceCell;
  const digits = latin(referenceCell).replace(NOISE, '');
  const reference = digits.replace(/^0+/, '');
  if (!/^\d+$/.test(digits) || reference === '') {
    return unreadable('BAD_REFERENCE');
  }

  const amountText = latin(amountCell)
    .replace(NOISE, '')
    .replace(THOUSANDS, '');
  if (
    !/^\d+$/.test(amountText) ||
    BigInt(amountText) <= 0n ||
    BigInt(amountText) > INT64_MAX
  ) {
    return unreadable('BAD_AMOUNT');
  }

  const jalaliDate = latin(date).replace(NOISE, '');
  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(jalaliDate)) return unreadable('BAD_DATE');

  return {
    line,
    rowNumber: latin(rowNumber).trim(),
    jalaliDate,
    reference,
    referenceRaw,
    amountRial: BigInt(amountText),
    description: description.trim(),
  };
}

/**
 * @function parseSettlement
 * @description Reads the PSP's settlement file as the probe found it: UTF-8 with a BOM, CRLF, a Persian header, Persian or Latin digits,
 * `٬` or `,` as thousands separators, the bank reference zero-padded to 13 digits, padded with spaces or bare, a repeated row number for a repeated row.
 * A row that cannot be read is returned in `unreadable` with its reason; it is never dropped.
 * @param csv - the file's text
 * @returns the readable rows and the unreadable ones
 * @throws {SettlementFormatError} when the header is not the expected one: this is not the file we know
 */
export function parseSettlement(csv: string): ParsedSettlement {
  const all = records(csv.replace(/^\uFEFF/, ''));
  const [header, ...body] = all;
  const names = header?.cells.map((c) => c.trim()) ?? [];
  if (
    names.length !== SETTLEMENT_HEADER.length ||
    names.some((n, i) => n !== SETTLEMENT_HEADER[i])
  ) {
    throw new SettlementFormatError(
      `unexpected settlement header: ${JSON.stringify(names).slice(0, 200)}`,
    );
  }
  const rows: SettlementRow[] = [];
  const unreadable: UnreadableRow[] = [];
  for (const record of body) {
    const read = readRow(record.line, record.cells);
    if ('reason' in read) unreadable.push(read);
    else rows.push(read);
  }
  return { rows, unreadable };
}
