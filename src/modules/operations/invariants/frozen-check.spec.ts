import { Money } from '../../../common/money';
import { frozenMismatches } from './frozen-check';

const irr = (n: bigint) => Money.rial(n);
const usdt = (n: bigint) => Money.microUsdt(n);

describe('frozenMismatches', () => {
  it('passes when FROZEN equals the open withdrawals, summed per user and currency', () => {
    expect(
      frozenMismatches(
        [{ userId: 'alice', balance: irr(300n) }],
        [
          { userId: 'alice', amount: irr(100n) },
          { userId: 'alice', amount: irr(200n) },
        ],
      ),
    ).toEqual([]);
  });

  it('reports money frozen with no open withdrawal', () => {
    expect(
      frozenMismatches([{ userId: 'alice', balance: irr(50n) }], []),
    ).toEqual([
      {
        user_id: 'alice',
        currency: 'IRR',
        frozen_minor: '50',
        open_withdrawals_minor: '0',
      },
    ]);
  });

  it('reports an open withdrawal with nothing frozen', () => {
    expect(
      frozenMismatches([], [{ userId: 'bob', amount: usdt(11_000_000n) }]),
    ).toEqual([
      {
        user_id: 'bob',
        currency: 'USDT',
        frozen_minor: '0',
        open_withdrawals_minor: '11000000',
      },
    ]);
  });

  it('keeps currencies apart and sorts the report', () => {
    const rows = frozenMismatches(
      [
        { userId: 'bob', balance: irr(1n) },
        { userId: 'alice', balance: usdt(5n) },
        { userId: 'alice', balance: irr(9n) },
      ],
      [{ userId: 'alice', amount: irr(9n) }],
    );
    expect(rows.map((r) => [r.user_id, r.currency])).toEqual([
      ['alice', 'USDT'],
      ['bob', 'IRR'],
    ]);
  });
});
