import { Tx } from '../../database/transaction-runner';
import { LedgerService } from './ledger.service';
import { AccountsRepository } from './repositories/accounts.repository';

const ROWS = [
  { id: '11', kind: 'AVAILABLE' },
  { id: '12', kind: 'FROZEN' },
  { id: '13', kind: 'DEBT' },
];

function txReturning(...selects: object[][]): {
  tx: Tx;
  statements: string[];
} {
  const statements: string[] = [];
  const queue = [...selects];
  const query = (sql: string): Promise<{ records: object[] }> => {
    const verb = sql.trim().split(/\s+/)[0].toUpperCase();
    statements.push(verb);
    return Promise.resolve({
      records: verb === 'SELECT' ? queue.shift()! : [],
    });
  };
  return { tx: { queryRunner: { query } } as unknown as Tx, statements };
}

describe('LedgerService.ensureUserAccounts', () => {
  const service = new LedgerService(new AccountsRepository());

  it('reads only when the accounts exist', async () => {
    const { tx, statements } = txReturning(ROWS);
    await expect(
      service.ensureUserAccounts(tx, 'alice', 'IRR'),
    ).resolves.toEqual({ available: 11n, frozen: 12n, debt: 13n });
    expect(statements).toEqual(['SELECT']);
  });

  it('inserts then re-reads on first use', async () => {
    const { tx, statements } = txReturning([], ROWS);
    await expect(
      service.ensureUserAccounts(tx, 'alice', 'USDT'),
    ).resolves.toEqual({ available: 11n, frozen: 12n, debt: 13n });
    expect(statements).toEqual(['SELECT', 'INSERT', 'SELECT']);
  });

  it('completes a partial set', async () => {
    const { tx, statements } = txReturning(ROWS.slice(0, 2), ROWS);
    await service.ensureUserAccounts(tx, 'alice', 'IRR');
    expect(statements).toEqual(['SELECT', 'INSERT', 'SELECT']);
  });

  it('keeps ids as bigint beyond 2^53', async () => {
    const big = '9007199254740993';
    const { tx } = txReturning([
      { id: big, kind: 'AVAILABLE' },
      { id: '2', kind: 'FROZEN' },
      { id: '3', kind: 'DEBT' },
    ]);
    const ids = await service.ensureUserAccounts(tx, 'alice', 'IRR');
    expect(ids.available).toBe(9_007_199_254_740_993n);
  });

  it('fails loudly if the accounts are still missing after the insert', async () => {
    const { tx } = txReturning([], []);
    await expect(
      service.ensureUserAccounts(tx, 'alice', 'IRR'),
    ).rejects.toThrow(/missing after insert/);
  });
});
