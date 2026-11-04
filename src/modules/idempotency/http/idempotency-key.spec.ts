import {
  Body,
  Controller,
  INestApplication,
  Module,
  Post,
  Res,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import type { Response } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule, AppRole } from '../../../app.module';
import { TEST_ENV } from '../../../config/testing';
import { fakeDataSource } from '../../../database/testing';
import {
  FinancialPost,
  IdempotencyExempt,
  IdempotencyKey,
  sendIdempotent,
} from './idempotency-key';
import { unmarkedPostRoutes } from './route-audit';

beforeAll(() => Object.assign(process.env, TEST_ENV));

class AmountDto {
  @IsString() amount!: string;
}

@Controller('probe')
class ProbeController {
  @FinancialPost('withdrawals')
  withdraw(@IdempotencyKey() key: string, @Body() body: AmountDto) {
    return { key, amount: body.amount };
  }

  @FinancialPost('replayed')
  replayed(@Res({ passthrough: true }) res: Response) {
    return sendIdempotent(res, { status: 422, body: { code: 'X' } }, true);
  }

  @Post('webhooks/payout')
  @IdempotencyExempt('provider webhook: the provider never sends the header')
  webhook() {
    return { ok: true };
  }

  @Post('forgot')
  forgot() {
    return { ok: true };
  }
}

@Controller('reconciliation')
@IdempotencyExempt('reconciliation changes no money')
class ExemptController {
  @Post('run')
  run() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController, ExemptController] })
class ProbeModule {}

describe('financial POSTs over HTTP', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRole('api'), ProbeModule],
    })
      .overrideProvider(DataSource)
      .useValue(fakeDataSource())
      .compile();
    app = ref.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string) => request(app.getHttpServer()).post(path);

  it('refuses a financial POST without the header: 400 IDEMPOTENCY_KEY_REQUIRED', async () => {
    const res = await post('/probe/withdrawals').send({ amount: '1' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: 'Idempotency-Key header is required',
    });
  });

  it('treats an empty header as missing', async () => {
    const res = await post('/probe/withdrawals')
      .set('Idempotency-Key', '')
      .send({ amount: '1' });
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('checks the header before the body', async () => {
    const res = await post('/probe/withdrawals').send({ amount: 5 });
    expect(res.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('refuses a key longer than 255 characters: 400 VALIDATION_ERROR', async () => {
    const res = await post('/probe/withdrawals')
      .set('Idempotency-Key', 'k'.repeat(256))
      .send({ amount: '1' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('passes a valid key to the handler', async () => {
    const res = await post('/probe/withdrawals')
      .set('Idempotency-Key', 'order-42 retry')
      .send({ amount: '1' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ key: 'order-42 retry', amount: '1' });
  });

  it('answers a replay with the stored status and Idempotent-Replayed: true', async () => {
    const res = await post('/probe/replayed').set('Idempotency-Key', 'k1');
    expect(res.status).toBe(422);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(res.body).toEqual({ code: 'X' });
  });

  it.each(['/probe/webhooks/payout', '/reconciliation/run'])(
    'lets the exempt %s through without the header',
    async (path) => {
      const res = await post(path);
      expect(res.status).toBe(201);
    },
  );
});

describe('route audit: every POST is financial or exempt', () => {
  const routesOf = async (
    imports: Parameters<typeof Test.createTestingModule>[0]['imports'],
  ) => {
    const ref = await Test.createTestingModule({ imports })
      .overrideProvider(DataSource)
      .useValue(fakeDataSource())
      .compile();
    return unmarkedPostRoutes(ref.get(ModulesContainer));
  };

  it.each(['api', 'worker', 'all'] as const)(
    'the app (APP_ROLE=%s) has no unmarked POST route',
    async (role: AppRole) => {
      expect(await routesOf([AppModule.forRole(role)])).toEqual([]);
    },
  );

  it('catches a POST that is neither', async () => {
    expect(await routesOf([AppModule.forRole('api'), ProbeModule])).toEqual([
      'POST /probe/forgot',
    ]);
  });
});
