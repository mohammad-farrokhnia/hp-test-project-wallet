import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { resolveRequestId } from '../logging/request-id';
import { toAppError } from './error-mapper';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const error = toAppError(exception);
    const requestId = resolveRequestId(req, res);

    if (error.status >= 500) {
      const level = error.status === 500 ? 'error' : 'warn';
      this.logger[level](
        { err: exception, code: error.code },
        'request failed',
      );
    }

    if (!(req as { log?: unknown }).log) {
      this.logger.warn(
        {
          requestId,
          method: req.method,
          url: req.url,
          status: error.status,
          code: error.code,
        },
        'request rejected before routing',
      );
    }

    if (!res.headersSent) res.status(error.status).json(error.toBody());
  }
}
