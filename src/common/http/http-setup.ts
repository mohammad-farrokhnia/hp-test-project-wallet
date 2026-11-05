import type { NestExpressApplication } from '@nestjs/platform-express';
import type { IncomingMessage } from 'node:http';

/** Options every entry point passes to `NestFactory.create` / `createNestApplication`; the parsers are registered by `configureBodyParsing`. */
export const APP_OPTIONS = { rawBody: true, bodyParser: false } as const;

/** Same ceiling as Express's default, so nothing changes for ordinary routes. */
export const BODY_LIMIT = '100kb';

const WEBHOOK_PREFIX = '/webhooks/';
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

/** The PSP callback and the payout webhook: provider traffic whose body is evidence, valid JSON or not. */
export function isWebhook(req: IncomingMessage): boolean {
  return (req.url ?? '').startsWith(WEBHOOK_PREFIX);
}

function isJson(req: IncomingMessage): boolean {
  return JSON_CONTENT_TYPE.test(req.headers['content-type'] ?? '');
}

/**
 * @function configureBodyParsing
 * @description Registers the body parsers. Webhook routes get the raw bytes whatever their content type, so a delivery that is not valid JSON
 * still reaches `PspCallbackService` / `PayoutWebhookService`, is recorded as received, and gets their answer (200, or 401 for a bad signature)
 * instead of a 400 from the parser before any of our code runs. Every other route keeps strict JSON and form parsing.
 * `req.rawBody` is set for both, so the HMAC is still computed over the exact bytes received.
 * @param app - the application, created with `APP_OPTIONS`
 */
export function configureBodyParsing(app: NestExpressApplication): void {
  app.useBodyParser('raw', { type: isWebhook, limit: BODY_LIMIT });
  app.useBodyParser('json', {
    type: (req: IncomingMessage) => !isWebhook(req) && isJson(req),
    limit: BODY_LIMIT,
  });
  app.useBodyParser('urlencoded', { extended: true, limit: BODY_LIMIT });
}
