import {
  Controller,
  Get,
  INestApplication,
  Logger,
  Module,
  Type,
} from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule, AppRole } from '../../app.module';
import { AppConfig, loadConfig } from '../../config/app-config';
import { TEST_ENV } from '../../config/testing';
import { fakeDataSource } from '../../database/testing';
import { InvariantsService } from '../../modules/operations';
import { InternalApiKeyNotice, sameSecret } from './internal-api-key.guard';
import { unguardedInternalControllers } from './internal-route-audit';

beforeAll(() => Object.assign(process.env, TEST_ENV));

const REPORT = { ok: true, checkedAt: 'now', checks: [] };

async function boot(internalApiKey: string, extra: Type[] = []) {
  const ref = await Test.createTestingModule({
    imports: [AppModule.forRole('api'), ...extra],
  })
    .overrideProvider(DataSource)
    .useValue(fakeDataSource())
    .overrideProvider(AppConfig)
    .useValue(loadConfig({ ...TEST_ENV, INTERNAL_API_KEY: internalApiKey }))
    .overrideProvider(InvariantsService)
    .useValue({ check: () => Promise.resolve(REPORT) })
    .compile();
  const app = ref.createNestApplication<INestApplication<App>>({
    rawBody: true,
  });
  await app.init();
  return app;
}

describe('InternalApiKeyGuard off (INTERNAL_API_KEY empty)', () => {
  let app: INestApplication<App>;
  let warn: jest.SpyInstance;

  beforeAll(async () => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    app = await boot('');
  });
  afterAll(async () => {
    await app.close();
    warn.mockRestore();
  });

  it('lets internal routes through without a key', async () => {
    const res = await request(app.getHttpServer()).get('/internal/invariants');
    expect(res.status).toBe(200);
  });

  it('warns at boot that the internal API is open', () => {
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('INTERNAL_API_KEY is not set'),
    );
  });
});

describe('InternalApiKeyGuard on (INTERNAL_API_KEY set)', () => {
  let app: INestApplication<App>;
  let warn: jest.SpyInstance;
  const get = () => request(app.getHttpServer()).get('/internal/invariants');

  beforeAll(async () => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    app = await boot('s3cret');
  });
  afterAll(async () => {
    await app.close();
    warn.mockRestore();
  });

  it('does not warn at boot', () => {
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('INTERNAL_API_KEY is not set'),
    );
  });

  it('refuses a request without the key: 401 UNAUTHORIZED', async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ code: 'UNAUTHORIZED', message: 'Unauthorized' });
  });

  it.each(['wrong', 's3cre', 'S3CRET', ''])(
    'refuses the wrong key %j',
    async (key) => {
      expect((await get().set('X-Internal-Api-Key', key)).status).toBe(401);
    },
  );

  it('accepts the right key', async () => {
    const res = await get().set('X-Internal-Api-Key', 's3cret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(REPORT);
  });

  it('checks the internal key before the Idempotency-Key', async () => {
    const res = await request(app.getHttpServer())
      .post('/internal/adjustments')
      .send({});
    expect(res.status).toBe(401);
  });
});

describe('sameSecret', () => {
  it.each([
    ['s3cret', 's3cret', true],
    ['s3cret', 's3creT', false],
    ['s3cret', 's3cret-longer', false],
    ['', 's3cret', false],
  ])('%j vs %j → %s', (a, b, same) => {
    expect(sameSecret(a, b)).toBe(same);
  });
});

describe('InternalApiKeyNotice', () => {
  it('warns only when the key is off', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const notice = (key: string) =>
      new InternalApiKeyNotice(
        loadConfig({ ...TEST_ENV, INTERNAL_API_KEY: key }),
      ).onApplicationBootstrap();
    notice('k');
    expect(warn).not.toHaveBeenCalled();
    notice('');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('every internal controller is guarded', () => {
  @Controller('internal/forgotten')
  class ForgottenController {
    @Get()
    open() {
      return {};
    }
  }
  @Module({ controllers: [ForgottenController] })
  class ForgottenModule {}

  const unguarded = async (
    imports: (Type | ReturnType<typeof AppModule.forRole>)[],
  ) => {
    const ref = await Test.createTestingModule({ imports })
      .overrideProvider(DataSource)
      .useValue(fakeDataSource())
      .compile();
    return unguardedInternalControllers(ref.get(ModulesContainer));
  };

  it.each(['api', 'worker', 'all'] as const)(
    'the app (APP_ROLE=%s) has none without @InternalOnly()',
    async (role: AppRole) => {
      expect(await unguarded([AppModule.forRole(role)])).toEqual([]);
    },
  );

  it('catches one that forgot', async () => {
    expect(
      await unguarded([AppModule.forRole('api'), ForgottenModule]),
    ).toEqual(['ForgottenController']);
  });
});

describe('compose leaves the guard off', () => {
  it('docker-compose.yml never sets INTERNAL_API_KEY', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8');
    expect(compose).not.toMatch(/INTERNAL_API_KEY\s*[:=]\s*\S/);
  });

  it('.env.example ships it empty', () => {
    const example = readFileSync('.env.example', 'utf8');
    expect(example).toMatch(/^INTERNAL_API_KEY=$/m);
  });
});
