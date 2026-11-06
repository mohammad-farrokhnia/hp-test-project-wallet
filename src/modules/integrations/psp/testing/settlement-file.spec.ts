import { parseSettlement } from '../settlement-csv';
import { settlementFile, withLines } from './settlement-file';

const rows = [
  { reference: '3005946226', amountRial: 1_000_000n, token: 'A07fc73e' },
  { reference: '2927489111', amountRial: 10_000n, token: 'A06286f2' },
  { reference: '8239046895', amountRial: 3_000_000n, token: 'A0823caf' },
  { reference: '8297653641', amountRial: 2_600_000n },
  { reference: '1000000007', amountRial: 123_456_789n, token: 'A0abcdef' },
];

describe('settlementFile (the test builder)', () => {
  const text = settlementFile('2026-11-06', rows);

  it('writes what the real file looks like: a BOM, CRLF, the Persian header', () => {
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('\r\n');
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.split('\r\n')[0]).toContain('شماره پیگیری');
  });

  it('writes the four styles of the real file, in its order', () => {
    const lines = text.split('\r\n');
    expect(lines[1]).toContain('0003005946226');
    expect(lines[2]).toContain(',1405/08/15, 2927489111 ,');
    expect(lines[3]).toContain(',8239046895,');
    expect(lines[4]).toContain(',0008297653641,');
    expect(lines[2]).toContain('"10,000"');
    expect(lines[1]).toContain(String.fromCharCode(0x066c));
    expect(lines[1]).toContain(String.fromCharCode(0x06f1));
  });

  it('parses back to exactly what went in, in every style', () => {
    const { rows: read, unreadable } = parseSettlement(text);
    expect(unreadable).toEqual([]);
    expect(read.map((r) => [r.reference, r.amountRial])).toEqual(
      rows.map((r) => [r.reference, r.amountRial]),
    );
    expect(read.every((r) => r.jalaliDate === '1405/08/15')).toBe(true);
  });

  it('prints the PSP token in the description, or its "unknown" text', () => {
    const { rows: read } = parseSettlement(text);
    expect(read[0].description).toMatch(/A07fc73e$/);
    expect(read[3].description).toMatch(/نامشخص$/);
  });

  it('appends raw lines for what the builder would never write', () => {
    const more = withLines(text, 'garbage', '1,2');
    expect(parseSettlement(more).unreadable).toHaveLength(2);
  });
});
