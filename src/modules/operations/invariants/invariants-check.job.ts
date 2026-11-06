import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfig } from '../../../config/app-config';
import { InvariantsReport, InvariantsService } from './invariants.service';

/**
 * @class InvariantsCheckJob
 * @description Worker role: every `INVARIANTS_CHECK_INTERVAL_MINUTES`, runs the same checks as `GET /internal/invariants` and logs an `ALERT` at error level when any fails,
 * so drift between balances and postings is found by the system rather than by a user. Reads only; it never corrects anything.
 */
@Injectable()
export class InvariantsCheckJob
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(InvariantsCheckJob.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly invariants: InvariantsService,
    private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    const everyMs = this.config.invariants.checkIntervalMinutes * 60_000;
    this.timer = setInterval(() => void this.run(), everyMs);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /**
   * @function run
   * @description One scheduled round; skipped while the previous one is still going. Errors are logged, never thrown, so the timer keeps running.
   * @returns the report, or `null` when the check itself could not run
   */
  async run(): Promise<InvariantsReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const report = await this.invariants.check();
      const failed = report.checks.filter((c) => !c.ok);
      if (failed.length > 0) {
        const summary = failed
          .map(
            (c) =>
              `${c.name} (${c.violations.length}${c.truncated ? '+' : ''})`,
          )
          .join(', ');
        this.logger.error(`ALERT invariants broken: ${summary}`);
      } else {
        this.logger.debug('invariants ok');
      }
      return report;
    } catch (err) {
      this.logger.error(
        `invariants check failed to run: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    } finally {
      this.running = false;
    }
  }
}
