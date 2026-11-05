import { z } from 'zod';
import { buildAmqpUrl, buildDatabaseUrl } from './database-url';
import { Env, envSchema } from './env.schema';

export class AppConfig {
  readonly role: Env['APP_ROLE'];
  readonly logLevel: Env['LOG_LEVEL'];
  readonly http: { port: number; publicBaseUrl: string; timeoutMs: number };
  readonly db: {
    url: string;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
  };
  readonly rabbit: {
    url: string;
    publishTimeoutMs: number;
    publishRetries: number;
  };
  readonly psp: { baseUrl: string };
  readonly payout: { baseUrl: string; webhookSecret: string };
  readonly internalApiKey: string | null;
  readonly limits: {
    depositMinRial: bigint;
    withdrawMinRial: bigint;
    withdrawDailyLimitRial: bigint;
    usdtWithdrawMinMicro: bigint;
    usdtWithdrawFeeMicro: bigint;
  };
  readonly timing: { depositExpiryMinutes: number; reviewAfterMinutes: number };
  readonly idempotency: {
    retentionDays: number;
    cleanupIntervalMinutes: number;
  };

  constructor(e: Env) {
    this.role = e.APP_ROLE;
    this.logLevel = e.LOG_LEVEL;
    this.http = {
      port: e.PORT,
      publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/$/, ''),
      timeoutMs: e.HTTP_TIMEOUT_MS,
    };
    this.db = {
      url: buildDatabaseUrl({
        host: e.POSTGRES_HOST,
        port: e.POSTGRES_PORT,
        user: e.POSTGRES_USER,
        password: e.POSTGRES_PASSWORD,
        database: e.POSTGRES_DB,
      }),
      lockTimeoutMs: e.DB_LOCK_TIMEOUT_MS,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    };
    this.rabbit = {
      url: buildAmqpUrl({
        host: e.RABBITMQ_HOST,
        port: e.RABBITMQ_PORT,
        user: e.RABBITMQ_USER,
        password: e.RABBITMQ_PASSWORD,
      }),
      publishTimeoutMs: e.RABBITMQ_PUBLISH_TIMEOUT_MS,
      publishRetries: e.RABBITMQ_PUBLISH_RETRIES,
    };
    this.psp = { baseUrl: e.PSP_BASE_URL.replace(/\/$/, '') };
    this.payout = {
      baseUrl: e.PAYOUT_BASE_URL.replace(/\/$/, ''),
      webhookSecret: e.PAYOUT_WEBHOOK_SECRET,
    };
    this.internalApiKey = e.INTERNAL_API_KEY === '' ? null : e.INTERNAL_API_KEY;
    this.limits = {
      depositMinRial: e.DEPOSIT_MIN_TOMAN,
      withdrawMinRial: e.WITHDRAW_MIN_TOMAN,
      withdrawDailyLimitRial: e.WITHDRAW_DAILY_LIMIT_TOMAN,
      usdtWithdrawMinMicro: e.USDT_WITHDRAW_MIN_MICRO,
      usdtWithdrawFeeMicro: e.USDT_WITHDRAW_FEE_MICRO,
    };
    this.timing = {
      depositExpiryMinutes: e.DEPOSIT_EXPIRY_MINUTES,
      reviewAfterMinutes: e.REVIEW_AFTER_MINUTES,
    };
    this.idempotency = {
      retentionDays: e.IDEMPOTENCY_RETENTION_DAYS,
      cleanupIntervalMinutes: e.IDEMPOTENCY_CLEANUP_INTERVAL_MINUTES,
    };
    Object.freeze(this);
  }
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  return new AppConfig(parsed.data);
}
