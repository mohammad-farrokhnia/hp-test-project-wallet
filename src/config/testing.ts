export const TEST_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://wallet:wallet@localhost:5432/wallet',
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
  PSP_BASE_URL: 'http://localhost:8080',
  PAYOUT_BASE_URL: 'http://localhost:8080',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  PAYOUT_WEBHOOK_SECRET: 'hamtapay-sim-secret',
};
