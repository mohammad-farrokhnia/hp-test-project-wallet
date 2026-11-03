import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';

const ACCEPTED_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * @function resolveRequestId
 * @description Reuses a well-formed incoming `X-Request-Id`, otherwise generates one, and echoes it on the response. Idempotent per request.
 * @param req - the incoming request
 * @param res - the response to set the header on
 * @returns the request id
 */
export function resolveRequestId(
  req: IncomingMessage & { id?: unknown },
  res: ServerResponse,
): string {
  if (typeof req.id === 'string') return req.id;
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id =
    typeof incoming === 'string' && ACCEPTED_ID.test(incoming)
      ? incoming
      : randomUUID();
  req.id = id;
  if (!res.headersSent) res.setHeader('X-Request-Id', id);
  return id;
}
