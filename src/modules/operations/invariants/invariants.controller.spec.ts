import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../../app.module';
import { TEST_ENV } from '../../../config/testing';
import { fakeDataSource } from '../../../database/testing';
import { InvariantsReport, InvariantsService } from './invariants.service';

beforeAll(() => Object.assign(process.env, TEST_ENV));

describe('GET /internal/invariants', () => {
  let app: INestApplication<App>;
  let report: InvariantsReport;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRole('api')],
    })
      .overrideProvider(DataSource)
      .useValue(fakeDataSource())
      .overrideProvider(InvariantsService)
      .useValue({ check: () => Promise.resolve(report) })
      .compile();
    app = ref.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the report with 200 when the books are consistent', async () => {
    report = {
      ok: true,
      checkedAt: '2026-11-04T08:00:00.000Z',
      checks: [
        { name: 'ZERO_SUM', ok: true, violations: [], truncated: false },
      ],
    };
    const res = await request(app.getHttpServer()).get('/internal/invariants');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
  });

  it('still returns 200, with ok false and the violations, when they are not', async () => {
    report = {
      ok: false,
      checkedAt: '2026-11-04T08:00:00.000Z',
      checks: [
        {
          name: 'FROZEN_EQUALS_OPEN_WITHDRAWALS',
          ok: false,
          violations: [
            {
              user_id: 'alice',
              currency: 'IRR',
              frozen_minor: '40',
              open_withdrawals_minor: '0',
            },
          ],
          truncated: false,
        },
      ],
    };
    const res = await request(app.getHttpServer()).get('/internal/invariants');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
  });
});
