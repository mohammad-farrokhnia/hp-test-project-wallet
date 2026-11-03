import { z } from 'zod';

const wholeNumber = z
  .string()
  .regex(/^\d+$/, 'must be a whole number, no decimals');

const toman = (def: string) =>
  wholeNumber.default(def).transform((s) => BigInt(s) * 10n);
const micro = (def: string) =>
  wholeNumber.default(def).transform((s) => BigInt(s));
const int = (def: number) => z.coerce.number().int().positive().default(def);

export const envSchema = z.object({
  APP_ROLE: z.enum(['api', 'worker']).default('api'),
  PORT: int(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.url(),
  RABBITMQ_URL: z.url(),

  PSP_BASE_URL: z.url(),
  PAYOUT_BASE_URL: z.url(),
  PUBLIC_BASE_URL: z.url(),
  PAYOUT_WEBHOOK_SECRET: z.string().min(1),
  INTERNAL_API_KEY: z.string().default(''),

  HTTP_TIMEOUT_MS: int(5000),
  DB_LOCK_TIMEOUT_MS: int(3000),
  DB_STATEMENT_TIMEOUT_MS: int(5000),

  DEPOSIT_MIN_TOMAN: toman('1000'),
  WITHDRAW_MIN_TOMAN: toman('100000'),
  WITHDRAW_DAILY_LIMIT_TOMAN: toman('200000000'),
  USDT_WITHDRAW_MIN_MICRO: micro('10000000'),
  USDT_WITHDRAW_FEE_MICRO: micro('1000000'),

  DEPOSIT_EXPIRY_MINUTES: int(1440),
  REVIEW_AFTER_MINUTES: int(30),
});

export type Env = z.infer<typeof envSchema>;
