import {
  Body,
  Controller,
  Get,
  INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { DataSource, QueryFailedError } from 'typeorm';
import { App } from 'supertest/types';
import { AppModule } from '../../app.module';
import { fakeDataSource } from '../../database/testing';
import { buildPinoHttpOptions, LoggingModule } from '../logging';
import { MoneyError } from '../money';
import { AppError } from './app-error';
import { ERROR_CATALOG } from './error-catalog';

class LegDto {
  @IsString() @Length(1, 8) name!: string;
}

class DepositDto {
  @IsString() @Matches(/^[0-9]+$/) amount!: string;
  @IsIn(['IRT', 'USDT']) currency!: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LegDto)
  legs?: LegDto[];
}

const dbError = (code: string) =>
  new QueryFailedError(
    'INSERT INTO secrets VALUES (1)',
    [],
    Object.assign(new Error('duplicate key value violates "uq_secret"'), {
      code,
    }),
  );

@Controller('probe')
class ProbeController {
  @Post('deposit')
  deposit(@Body() body: DepositDto) {
    return { ok: true, amount: body.amount };
  }
  @Get('app-error')
  appError() {
    throw new AppError('INSUFFICIENT_FUNDS');
  }
  @Get('boom')
  boom() {
    throw new Error('password=hunter2 at /srv/app/secret.js');
  }
  @Get('thrown-string')
  thrownString() {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw 'a bare string';
  }
  @Get('lock-timeout')
  lockTimeout() {
    throw dbError('55P03');
  }
  @Get('unique-violation')
  uniqueViolation() {
    throw dbError('23505');
  }
  @Get('money-input')
  moneyInput() {
    throw new MoneyError('INVALID_AMOUNT', '"1e5" is not a plain decimal');
  }
  @Get('money-bug')
  moneyBug() {
    throw new MoneyError('OUT_OF_RANGE', '99999999999999999999 does not fit');
  }
}

const logLines: Record<string, unknown>[] = [];
const captureStream = {
  write: (line: string) => {
    logLines.push(JSON.parse(line) as Record<string, unknown>);
  },
};

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: [
        { ...buildPinoHttpOptions({ logLevel: 'info', role: 'api' }) },
        captureStream,
      ],
    }),
  ],
})
class CapturingLoggingModule {}

describe('error contract over HTTP', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRole('api')],
      controllers: [ProbeController],
    })
      .overrideProvider(DataSource)
      .useValue(fakeDataSource())
      .overrideModule(LoggingModule)
      .useModule(CapturingLoggingModule)
      .compile();
    app = ref.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logLines.length = 0;
  });

  const expectContract = (
    res: request.Response,
    status: number,
    code: keyof typeof ERROR_CATALOG,
  ) => {
    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Object.keys(res.body as object).sort()).toEqual(['code', 'message']);
    expect((res.body as { code: string }).code).toBe(code);
    expect(typeof (res.body as { message: string }).message).toBe('string');
    expect(res.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
  };

  describe('routing', () => {
    it('unknown route → 404 NOT_FOUND', async () => {
      expectContract(
        await request(app.getHttpServer()).get('/nope'),
        404,
        'NOT_FOUND',
      );
    });

    it.each(['post', 'put', 'delete', 'patch'] as const)(
      '%s on a GET-only route → 404 NOT_FOUND',
      async (method) => {
        expectContract(
          await request(app.getHttpServer())[method]('/health'),
          404,
          'NOT_FOUND',
        );
      },
    );

    it('deep unknown path → 404 NOT_FOUND', async () => {
      expectContract(
        await request(app.getHttpServer()).get('/a/b/c/d'),
        404,
        'NOT_FOUND',
      );
    });
  });

  describe('validation (bad DTO)', () => {
    const post = (body: unknown) =>
      request(app.getHttpServer())
        .post('/probe/deposit')
        .send(body as object);

    it('accepts a valid body', async () => {
      const res = await post({ amount: '1000', currency: 'IRT' });
      expect(res.status).toBe(201);
    });

    it.each([
      ['an empty object', {}],
      ['a missing field', { amount: '1000' }],
      [
        'a number instead of a string (never coerced)',
        { amount: 1000, currency: 'IRT' },
      ],
      ['a wrong pattern', { amount: '1e5', currency: 'IRT' }],
      ['an unknown enum value', { amount: '1', currency: 'BTC' }],
      ['an unknown property', { amount: '1', currency: 'IRT', admin: true }],
      ['a null field', { amount: null, currency: 'IRT' }],
      [
        'a nested violation',
        { amount: '1', currency: 'IRT', legs: [{ name: '' }] },
      ],
      ['a nested wrong type', { amount: '1', currency: 'IRT', legs: ['x'] }],
    ])('%s → 400 VALIDATION_ERROR', async (_name, body) => {
      expectContract(await post(body), 400, 'VALIDATION_ERROR');
    });

    it.each([
      ['an array body', []],
      ['a string body', '"just a string"'],
      ['a null body', 'null'],
    ])('%s → 400 VALIDATION_ERROR', async (_name, body) => {
      const res = await request(app.getHttpServer())
        .post('/probe/deposit')
        .set('Content-Type', 'application/json')
        .send(typeof body === 'string' ? body : JSON.stringify(body));
      expectContract(res, 400, 'VALIDATION_ERROR');
    });

    it('names every problem in the message', async () => {
      const res = await post({ amount: 5, currency: 'BTC', extra: 1 });
      const { message } = res.body as { message: string };
      expect(message).toMatch(/amount/);
      expect(message).toMatch(/currency/);
      expect(message).toMatch(/extra/);
    });
  });

  describe('malformed requests', () => {
    it('malformed JSON → 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .post('/probe/deposit')
        .set('Content-Type', 'application/json')
        .send('{"amount": "1",');
      expectContract(res, 400, 'VALIDATION_ERROR');
    });

    it('oversized body → 400 VALIDATION_ERROR', async () => {
      const res = await request(app.getHttpServer())
        .post('/probe/deposit')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ amount: '1'.repeat(300_000), currency: 'IRT' }));
      expectContract(res, 400, 'VALIDATION_ERROR');
    });

    it('malformed JSON is logged with its request id even though routing never ran', async () => {
      await request(app.getHttpServer())
        .post('/probe/deposit')
        .set('X-Request-Id', 'parse-fail-1')
        .set('Content-Type', 'application/json')
        .send('{oops');
      const lines = logLines.filter((l) => l.requestId === 'parse-fail-1');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'warn',
        code: 'VALIDATION_ERROR',
        method: 'POST',
        url: '/probe/deposit',
        status: 400,
      });
    });

    it('malformed JSON still carries the incoming request id', async () => {
      const res = await request(app.getHttpServer())
        .post('/probe/deposit')
        .set('X-Request-Id', 'client-id-1')
        .set('Content-Type', 'application/json')
        .send('{oops');
      expect(res.headers['x-request-id']).toBe('client-id-1');
    });
  });

  describe('errors thrown by application code', () => {
    it.each([
      ['/probe/app-error', 422, 'INSUFFICIENT_FUNDS'],
      ['/probe/money-input', 400, 'VALIDATION_ERROR'],
      ['/probe/money-bug', 500, 'INTERNAL_ERROR'],
      ['/probe/lock-timeout', 503, 'SERVICE_BUSY'],
      ['/probe/unique-violation', 500, 'INTERNAL_ERROR'],
      ['/probe/boom', 500, 'INTERNAL_ERROR'],
      ['/probe/thrown-string', 500, 'INTERNAL_ERROR'],
    ] as const)('%s → %s %s', async (path, status, code) => {
      expectContract(
        await request(app.getHttpServer()).get(path),
        status,
        code,
      );
    });

    it.each([
      '/probe/boom',
      '/probe/unique-violation',
      '/probe/money-bug',
      '/probe/thrown-string',
    ])('%s does not leak internals to the client', async (path) => {
      const res = await request(app.getHttpServer()).get(path);
      expect(JSON.stringify(res.body)).not.toMatch(
        /hunter2|secret|INSERT|uq_|99999|bare string|\/srv/,
      );
      expect((res.body as { message: string }).message).toBe(
        ERROR_CATALOG.INTERNAL_ERROR.message,
      );
    });
  });

  describe('request id', () => {
    it('is generated when the client sends none', async () => {
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('echoes a well-formed incoming id on success and on error', async () => {
      const ok = await request(app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'abc-123');
      const bad = await request(app.getHttpServer())
        .get('/nope')
        .set('X-Request-Id', 'abc-124');
      expect(ok.headers['x-request-id']).toBe('abc-123');
      expect(bad.headers['x-request-id']).toBe('abc-124');
    });

    it('replaces an unacceptable id instead of echoing it', async () => {
      const res = await request(app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'x'.repeat(200));
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('differs between requests', async () => {
      const a = await request(app.getHttpServer()).get('/health');
      const b = await request(app.getHttpServer()).get('/health');
      expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
    });
  });

  describe('structured logs', () => {
    it('logs an unexpected error once with its stack and the request id, never to the client', async () => {
      const res = await request(app.getHttpServer())
        .get('/probe/boom')
        .set('X-Request-Id', 'trace-me');
      expect(res.status).toBe(500);

      const failure = logLines.find((l) => l.msg === 'request failed');
      expect(failure).toMatchObject({
        level: 'error',
        requestId: 'trace-me',
        code: 'INTERNAL_ERROR',
        role: 'api',
      });
      expect(JSON.stringify(failure)).toContain('hunter2');
    });

    it('logs one access line per request, with request id, method, url and status', async () => {
      await request(app.getHttpServer())
        .get('/nope')
        .set('X-Request-Id', 'access-1');
      const access = logLines.filter((l) => l.requestId === 'access-1');
      expect(access).toHaveLength(1);
      expect(access[0]).toMatchObject({
        level: 'warn',
        req: { method: 'GET', url: '/nope' },
        res: { statusCode: 404 },
      });
    });

    it('never logs request headers', async () => {
      await request(app.getHttpServer())
        .get('/probe/app-error')
        .set('Authorization', 'Bearer super-secret-token')
        .set('X-Internal-Api-Key', 'internal-key-123')
        .set('Cookie', 'session=abc');
      const text = JSON.stringify(logLines);
      expect(text).not.toMatch(
        /super-secret-token|internal-key-123|session=abc/,
      );
    });

    it('still logs a wrong-method request to /health', async () => {
      await request(app.getHttpServer())
        .post('/health')
        .set('X-Request-Id', 'health-post-1');
      const lines = logLines.filter((l) => l.requestId === 'health-post-1');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        req: { method: 'POST', url: '/health' },
        res: { statusCode: 404 },
      });
    });

    it('does not access-log GET /health (compose polls it every few seconds)', async () => {
      await request(app.getHttpServer())
        .get('/health')
        .set('X-Request-Id', 'health-1');
      expect(logLines.filter((l) => l.requestId === 'health-1')).toHaveLength(
        0,
      );
    });

    it('logs a 4xx client error as warn and a 5xx as error', async () => {
      await request(app.getHttpServer())
        .get('/probe/app-error')
        .set('X-Request-Id', 'lvl-4');
      await request(app.getHttpServer())
        .get('/probe/boom')
        .set('X-Request-Id', 'lvl-5');
      const level = (id: string) =>
        logLines.find((l) => l.requestId === id && l.res !== undefined)?.level;
      expect(level('lvl-4')).toBe('warn');
      expect(level('lvl-5')).toBe('error');
    });

    it('logs a lock timeout as a warning with its code', async () => {
      await request(app.getHttpServer())
        .get('/probe/lock-timeout')
        .set('X-Request-Id', 'busy-1');
      expect(logLines.find((l) => l.msg === 'request failed')).toMatchObject({
        level: 'warn',
        code: 'SERVICE_BUSY',
        requestId: 'busy-1',
      });
    });
  });
});
