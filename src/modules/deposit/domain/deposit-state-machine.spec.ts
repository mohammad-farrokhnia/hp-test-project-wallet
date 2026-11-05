import { Money } from '../../../common/money';
import type { VerifyOutcome } from '../../integrations/psp';
import {
  decideDepositSync,
  Observation,
  PendingDeposit,
} from './deposit-state-machine';

const REQUESTED = Money.rial(10_000_000n);
const FRESH: PendingDeposit = {
  requested: REQUESTED,
  checkAttempts: 0,
  ageSeconds: 5,
  expired: false,
};

const status = (
  s: 'INIT' | 'PAID' | 'VERIFIED' | 'FAILED' | 'REVERSED',
  verify: VerifyOutcome | null = null,
): Observation => ({ kind: 'STATUS', status: s, verify });
const ok = (rial: bigint, kind: 'OK' | 'ALREADY_VERIFIED' = 'OK') =>
  ({ kind, amount: Money.rial(rial), refId: 'REF1' }) as const;

describe('decideDepositSync', () => {
  describe('credit: only a verified amount, and only from PAID or VERIFIED', () => {
    it.each([
      ['PAID', 'OK'],
      ['PAID', 'ALREADY_VERIFIED'],
      ['VERIFIED', 'OK'],
      ['VERIFIED', 'ALREADY_VERIFIED'],
    ] as const)('%s + verify %s → D8 SUCCEEDED', (s, v) => {
      const d = decideDepositSync(status(s, ok(10_000_000n, v)), FRESH);
      expect(d).toMatchObject({
        rule: 'D8',
        to: 'SUCCEEDED',
        pspStatus: 'VERIFIED',
        paidSeen: true,
        nextCheckSeconds: null,
        review: undefined,
      });
      expect(d.credit?.amount.equals(REQUESTED)).toBe(true);
      expect(d.credit?.refId).toBe('REF1');
    });

    it('credits what verify says, and flags it when that differs from the request (PSP-07)', () => {
      const d = decideDepositSync(status('PAID', ok(100_000_000n)), FRESH);
      expect(d.credit?.amount.minor).toBe(100_000_000n);
      expect(d.review).toBe('AMOUNT_DIFFERS');
      const less = decideDepositSync(status('PAID', ok(9_000_000n)), FRESH);
      expect(less.credit?.amount.minor).toBe(9_000_000n);
      expect(less.review).toBe('AMOUNT_DIFFERS');
    });
  });

  describe('stays PENDING and retries', () => {
    it('verify unavailable (503, PSP-09) → D9, retry in 5 s, paid noted', () => {
      const d = decideDepositSync(
        status('PAID', { kind: 'UNAVAILABLE', reason: 'HTTP_503/code_-1' }),
        FRESH,
      );
      expect(d).toEqual({
        rule: 'D9',
        pspStatus: 'PAID',
        paidSeen: true,
        nextCheckSeconds: 5,
      });
    });

    it('verify -51 for a PAID payment (PSP-08) → D10, retry in 5 s', () => {
      const d = decideDepositSync(status('PAID', { kind: 'NOT_PAID' }), FRESH);
      expect(d).toMatchObject({
        rule: 'D10',
        paidSeen: true,
        nextCheckSeconds: 5,
      });
      expect(d.to).toBeUndefined();
      expect(d.credit).toBeUndefined();
    });

    it('PAID with no verify answer is treated as verify unavailable', () => {
      expect(decideDepositSync(status('PAID'), FRESH).rule).toBe('D9');
    });

    it.each([0, 1, 2, 3, 50])(
      'status INIT (the -51 case) → D6, follows the poll schedule (%i checks made)',
      (checkAttempts) => {
        const d = decideDepositSync(status('INIT'), {
          ...FRESH,
          checkAttempts,
        });
        expect(d).toMatchObject({
          rule: 'D6',
          pspStatus: 'INIT',
          paidSeen: false,
        });
        expect(d.to).toBeUndefined();
        expect(d.nextCheckSeconds).toBeGreaterThan(0);
      },
    );

    it('the PSP not answering never fails the deposit', () => {
      const d = decideDepositSync(
        { kind: 'PSP_UNAVAILABLE' },
        { ...FRESH, checkAttempts: 1 },
      );
      expect(d).toEqual({
        rule: 'WAIT',
        paidSeen: false,
        nextCheckSeconds: 15,
      });
    });
  });

  describe('fails the deposit only on the PSP status', () => {
    it('FAILED → D11 PSP_FAILED, nothing credited', () => {
      const d = decideDepositSync(status('FAILED'), FRESH);
      expect(d).toMatchObject({
        rule: 'D11',
        to: 'FAILED',
        failureReason: 'PSP_FAILED',
        nextCheckSeconds: null,
      });
      expect(d.credit).toBeUndefined();
    });

    it('REVERSED → D12 PSP_REVERSED, flagged for review, nothing credited (PSP-10)', () => {
      const d = decideDepositSync(status('REVERSED'), FRESH);
      expect(d).toMatchObject({
        rule: 'D12',
        to: 'FAILED',
        failureReason: 'PSP_REVERSED',
        review: 'UNVERIFIED_TOO_LONG',
        nextCheckSeconds: null,
      });
      expect(d.credit).toBeUndefined();
    });
  });

  describe('an unknown token (D16)', () => {
    const cases: [string, Observation][] = [
      ['lookup 404', { kind: 'UNKNOWN_TOKEN' }],
      ['verify -9', status('PAID', { kind: 'NOT_FOUND' })],
    ];
    it.each(cases)(
      '%s → flagged, checked again in 5 minutes, never failed',
      (_c, o) => {
        const d = decideDepositSync(o, FRESH);
        expect(d).toMatchObject({
          rule: 'D16',
          review: 'UNKNOWN_TOKEN',
          nextCheckSeconds: 300,
        });
        expect(d.to).toBeUndefined();
      },
    );
  });
});
