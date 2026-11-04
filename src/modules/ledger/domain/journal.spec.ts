import { Money } from '../../../common/money';
import {
  JournalInput,
  LockedAccount,
  planPostings,
  validateJournal,
} from './journal';

const irr = (n: bigint) => Money.rial(n);

const journal = (
  lines: JournalInput['lines'],
  over: Partial<JournalInput> = {},
): JournalInput => ({
  kind: 'TRANSFER',
  refId: '00000000-0000-7000-8000-000000000001',
  currency: 'IRR',
  lines,
  ...over,
});

const account = (
  id: bigint,
  balance: bigint,
  over: Partial<LockedAccount> = {},
): LockedAccount => ({
  id,
  userId: 'alice',
  kind: 'AVAILABLE',
  currency: 'IRR',
  balance: irr(balance),
  allowNegative: false,
  ...over,
});

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

const byId = (...accounts: LockedAccount[]) =>
  new Map(accounts.map((a) => [a.id, a]));

describe('validateJournal', () => {
  it('accepts lines that sum to zero', () => {
    expect(() =>
      validateJournal(
        journal([
          { accountId: 1n, amount: irr(-100n) },
          { accountId: 2n, amount: irr(60n) },
          { accountId: 3n, amount: irr(40n) },
        ]),
      ),
    ).not.toThrow();
  });

  it.each([
    ['fewer than two lines', [{ accountId: 1n, amount: irr(0n) }], /two lines/],
    [
      'lines that do not sum to zero',
      [
        { accountId: 1n, amount: irr(-100n) },
        { accountId: 2n, amount: irr(99n) },
      ],
      /sum to -1 IRR/,
    ],
    [
      'a zero line',
      [
        { accountId: 1n, amount: irr(0n) },
        { accountId: 2n, amount: irr(0n) },
      ],
      /is zero/,
    ],
    [
      'the same account twice',
      [
        { accountId: 1n, amount: irr(-5n) },
        { accountId: 1n, amount: irr(5n) },
      ],
      /appears twice/,
    ],
    [
      'a line in another currency',
      [
        { accountId: 1n, amount: irr(-5n) },
        { accountId: 2n, amount: Money.microUsdt(5n) },
      ],
      /is USDT, journal is IRR/,
    ],
  ])('rejects %s', (_case, lines, message) => {
    const err = thrownBy(() => validateJournal(journal(lines)));
    expect(err).toMatchObject({ code: 'INVALID_JOURNAL' });
    expect((err as Error).message).toMatch(message);
  });
});

describe('planPostings', () => {
  it('computes each balance after, in line order', () => {
    const plan = planPostings(
      journal([
        { accountId: 2n, amount: irr(-30n) },
        { accountId: 1n, amount: irr(30n) },
      ]),
      byId(account(1n, 0n), account(2n, 100n)),
    );
    expect(plan.map((p) => [p.account.id, p.balanceAfter.minor])).toEqual([
      [2n, 70n],
      [1n, 30n],
    ]);
  });

  it('lets a protected balance reach exactly zero', () => {
    const plan = planPostings(
      journal([
        { accountId: 1n, amount: irr(-100n) },
        { accountId: 2n, amount: irr(100n) },
      ]),
      byId(account(1n, 100n), account(2n, 0n)),
    );
    expect(plan[0].balanceAfter.minor).toBe(0n);
  });

  it('refuses to take a protected balance below zero', () => {
    expect(
      thrownBy(() =>
        planPostings(
          journal([
            { accountId: 1n, amount: irr(-101n) },
            { accountId: 2n, amount: irr(101n) },
          ]),
          byId(account(1n, 100n), account(2n, 0n)),
        ),
      ),
    ).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });

  it('lets system accounts and DEBT go negative', () => {
    const plan = planPostings(
      journal([
        { accountId: 1n, amount: irr(-500n) },
        { accountId: 2n, amount: irr(500n) },
      ]),
      byId(
        account(1n, 0n, {
          userId: null,
          kind: 'OPS_ADJUSTMENTS',
          allowNegative: true,
        }),
        account(2n, 0n),
      ),
    );
    expect(plan[0].balanceAfter.minor).toBe(-500n);
  });

  it('refuses to take DEBT above zero', () => {
    expect(
      thrownBy(() =>
        planPostings(
          journal([
            { accountId: 1n, amount: irr(-10n) },
            { accountId: 2n, amount: irr(10n) },
          ]),
          byId(
            account(1n, 10n),
            account(2n, -5n, { kind: 'DEBT', allowNegative: true }),
          ),
        ),
      ),
    ).toMatchObject({ code: 'INVALID_JOURNAL' });
  });

  it('refuses an account that was not found', () => {
    expect(
      thrownBy(() =>
        planPostings(
          journal([
            { accountId: 1n, amount: irr(-10n) },
            { accountId: 9n, amount: irr(10n) },
          ]),
          byId(account(1n, 10n)),
        ),
      ),
    ).toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
  });

  it('refuses an account in another currency than the journal', () => {
    expect(
      thrownBy(() =>
        planPostings(
          journal([
            { accountId: 1n, amount: irr(-10n) },
            { accountId: 2n, amount: irr(10n) },
          ]),
          byId(
            account(1n, 10n),
            account(2n, 0n, { currency: 'USDT', balance: Money.microUsdt(0n) }),
          ),
        ),
      ),
    ).toMatchObject({ code: 'INVALID_JOURNAL' });
  });
});
