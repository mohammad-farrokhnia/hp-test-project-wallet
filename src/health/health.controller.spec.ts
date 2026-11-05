import { DataSource } from 'typeorm';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule, AppRole } from '../app.module';
import { TEST_ENV } from '../config/testing';
import { fakeDataSource } from '../database/testing';
import { withoutBackgroundWork } from '../testing/without-background-work';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';

beforeAll(() => Object.assign(process.env, TEST_ENV));

describe('HealthController', () => {
  it('reports liveness without touching dependencies', () => {
    const check = jest.fn();
    const readiness = { check } as unknown as ReadinessService;
    expect(new HealthController(readiness).live()).toEqual({ status: 'ok' });
    expect(check).not.toHaveBeenCalled();
  });
});

describe.each(['api', 'worker', 'all'] as const)(
  'probes over HTTP (APP_ROLE=%s)',
  (role: AppRole) => {
    let app: INestApplication<App>;
    let databaseUp = true;

    beforeAll(async () => {
      const ref = await withoutBackgroundWork(
        Test.createTestingModule({ imports: [AppModule.forRole(role)] }),
      )
        .overrideProvider(DataSource)
        .useValue(
          fakeDataSource(() =>
            databaseUp
              ? Promise.resolve([{ '?column?': 1 }])
              : Promise.reject(new Error('connection refused')),
          ),
        )
        .compile();
      app = ref.createNestApplication({ rawBody: true });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      databaseUp = true;
    });

    it('/health answers 200 even when the database is down', async () => {
      databaseUp = false;
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('/ready answers 200 when the database is up', async () => {
      const res = await request(app.getHttpServer()).get('/ready');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
    });

    it('/ready fails with the error contract when the database is down', async () => {
      databaseUp = false;
      const res = await request(app.getHttpServer()).get('/ready');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        code: 'NOT_READY',
        message: 'Service is not ready',
      });
    });

    it('recovers once the database is back', async () => {
      databaseUp = false;
      await request(app.getHttpServer()).get('/ready').expect(503);
      databaseUp = true;
      await request(app.getHttpServer()).get('/ready').expect(200);
    });
  },
);
