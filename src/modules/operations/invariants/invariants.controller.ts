import { Controller, Get } from '@nestjs/common';
import { InvariantsReport, InvariantsService } from './invariants.service';

/**
 * @class InvariantsController
 * @description `GET /internal/invariants`:
 */
@Controller('internal')
export class InvariantsController {
  constructor(private readonly invariants: InvariantsService) {}

  @Get('invariants')
  check(): Promise<InvariantsReport> {
    return this.invariants.check();
  }
}
