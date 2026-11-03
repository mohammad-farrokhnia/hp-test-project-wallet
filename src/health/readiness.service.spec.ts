import { AppError } from '../common/errors';
import { fakeDataSource } from '../database/testing';
import { READINESS_TIMEOUT_MS, ReadinessService } from './readiness.service';

describe('ReadinessService', () => {
  afterEach(() => jest.useRealTimers());

  it('reports the database up when SELECT 1 answers', async () => {
    const service = new ReadinessService(fakeDataSource());
    await expect(service.check()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up' },
    });
  });

  it('throws NOT_READY when the database rejects', async () => {
    const service = new ReadinessService(
      fakeDataSource(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    await expect(service.check()).rejects.toMatchObject({
      code: 'NOT_READY',
      status: 503,
    });
    await expect(service.check()).rejects.toBeInstanceOf(AppError);
  });

  it('throws NOT_READY when the database does not answer in time', async () => {
    jest.useFakeTimers();
    const service = new ReadinessService(
      fakeDataSource(() => new Promise(() => undefined)),
    );
    const result = service.check();
    const assertion = expect(result).rejects.toMatchObject({
      code: 'NOT_READY',
    });
    await jest.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);
    await assertion;
  });
});
