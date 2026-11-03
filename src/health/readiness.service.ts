import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppError } from '../common/errors';

export const READINESS_TIMEOUT_MS = 2000;

export interface ReadinessReport {
  status: 'ok';
  checks: { database: 'up' };
}

/**
 * @class ReadinessService
 * @description Decides whether this instance can take traffic. Today that means the database answers `SELECT 1` within `READINESS_TIMEOUT_MS`.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(@Inject(DataSource) private readonly ds: DataSource) {}

  /**
   * @function check
   * @description Probes every dependency.
   * @returns the report when all dependencies are up
   * @throws AppError `NOT_READY` (503) when any dependency is down or too slow
   */
  async check(): Promise<ReadinessReport> {
    try {
      await this.withTimeout(this.ds.query('SELECT 1'));
    } catch (err) {
      this.logger.warn(
        `database check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new AppError('NOT_READY');
    }
    return { status: 'ok', checks: { database: 'up' } };
  }

  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${READINESS_TIMEOUT_MS} ms`)),
        READINESS_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
