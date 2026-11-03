import { Controller, Get } from '@nestjs/common';
import { ReadinessReport, ReadinessService } from './readiness.service';

/**
 * @class HealthController
 * @description Probe endpoints served by every role. `/health` is liveness (the process answers); `/ready` is readiness (its dependencies answer).
 */
@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('health')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): Promise<ReadinessReport> {
    return this.readiness.check();
  }
}
