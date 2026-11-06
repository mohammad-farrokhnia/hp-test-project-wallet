import { Logger } from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { InvariantCheck } from '../../ledger';
import { InvariantsCheckJob } from './invariants-check.job';
import { InvariantsReport, InvariantsService } from './invariants.service';

const config = { invariants: { checkIntervalMinutes: 5 } } as AppConfig;

const check = (
  name: InvariantCheck['name'],
  violations = 0,
  truncated = false,
): InvariantCheck => ({
  name,
  ok: violations === 0,
  violations: Array.from({ length: violations }, () => ({ user_id: 'u' })),
  truncated,
});

const report = (...checks: InvariantCheck[]): InvariantsReport => ({
  ok: checks.every((c) => c.ok),
  checkedAt: new Date(0).toISOString(),
  checks,
});

function jobWith(check: () => Promise<InvariantsReport>) {
  const service = { check } as unknown as InvariantsService;
  return new InvariantsCheckJob(service, config);
}

describe('InvariantsCheckJob', () => {
  let errors: jest.SpyInstance;

  beforeEach(() => {
    errors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs nothing at error level when every check passes', async () => {
    const job = jobWith(() =>
      Promise.resolve(report(check('ZERO_SUM'), check('NO_NEGATIVE_BALANCES'))),
    );

    expect((await job.run())?.ok).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it('raises one ALERT naming each failed check and its violation count, with + when truncated', async () => {
    const job = jobWith(() =>
      Promise.resolve(
        report(
          check('ZERO_SUM'),
          check('BALANCE_EQUALS_POSTINGS', 2),
          check('FROZEN_EQUALS_OPEN_WITHDRAWALS', 100, true),
        ),
      ),
    );

    await job.run();

    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(
      'ALERT invariants broken: BALANCE_EQUALS_POSTINGS (2), FROZEN_EQUALS_OPEN_WITHDRAWALS (100+)',
    );
  });

  it('a check that cannot run is logged and swallowed, so the schedule survives', async () => {
    const job = jobWith(() => Promise.reject(new Error('db down')));

    await expect(job.run()).resolves.toBeNull();
    expect(errors).toHaveBeenCalledWith(
      'invariants check failed to run: db down',
    );
  });

  it('skips a round while the previous one is still running', async () => {
    let finish!: (r: InvariantsReport) => void;
    const calls = jest.fn(
      () => new Promise<InvariantsReport>((resolve) => (finish = resolve)),
    );
    const job = jobWith(calls);

    const first = job.run();
    await expect(job.run()).resolves.toBeNull();
    finish(report(check('ZERO_SUM')));
    await first;

    expect(calls).toHaveBeenCalledTimes(1);
  });
});
