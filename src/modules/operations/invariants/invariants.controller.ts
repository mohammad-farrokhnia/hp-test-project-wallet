import { Controller, Get } from '@nestjs/common';
import { InternalOnly } from '../../../common/guards';
import { InvariantsReport, InvariantsService } from './invariants.service';

/**
 * @class InvariantsController
 * @description `GET /internal/invariants`:Always 200; `ok` says whether every check passed, because a report about broken books is still a successful answer.
 */
@Controller('internal')
@InternalOnly()
export class InvariantsController {
  constructor(private readonly invariants: InvariantsService) {}

  @Get('invariants')
  check(): Promise<InvariantsReport> {
    return this.invariants.check();
  }
}
