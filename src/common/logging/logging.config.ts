import { Options } from 'pino-http';
import { AppConfig } from '../../config/app-config';
import { resolveRequestId } from './request-id';

/**
 * @function buildPinoHttpOptions
 * @description Structured JSON logs: every line carries the `requestId`, request headers are never logged, `GET /health` is not access-logged.
 * @param config - log level and process role
 * @returns pino-http options
 */
export function buildPinoHttpOptions(
  config: Pick<AppConfig, 'logLevel' | 'role'>,
): Options {
  return {
    level: config.logLevel,
    base: { role: config.role },
    formatters: { level: (label: string) => ({ level: label }) },
    genReqId: resolveRequestId,
    quietReqLogger: true,
    customAttributeKeys: { reqId: 'requestId' },
    serializers: {
      req: (req: { method: string; url: string }) => ({
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-internal-api-key"]',
      ],
      remove: true,
    },
    autoLogging: {
      ignore: (req) => req.method === 'GET' && req.url === '/health',
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      return res.statusCode >= 400 ? 'warn' : 'info';
    },
  };
}
