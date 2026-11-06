import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';
import { AppError } from '../../../common/errors';
import { InternalOnly } from '../../../common/guards';
import { isUuid } from '../../../common/ids';
import { IdempotencyExempt } from '../../idempotency';
import { Mismatch } from './reconcile';
import {
  ReconciliationRun,
  ReconciliationService,
} from './reconciliation.service';

/** `POST /reconciliation/run` body: the Tehran day to reconcile; today when omitted. A real calendar day is checked by the service. */
export class RunReconciliationDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}

export interface MismatchView {
  readonly type: string;
  readonly reference: string | null;
  readonly depositId: string | null;
  readonly ourAmountRial: string | null;
  readonly theirAmountRial: string | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface RunView {
  readonly runId: string;
  readonly date: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly settlementRows: number;
  readonly matched: number;
  readonly mismatchCount: number;
  readonly mismatches: readonly MismatchView[];
}

const mismatchView = (m: Mismatch): MismatchView => ({
  type: m.type,
  reference: m.reference,
  depositId: m.depositId,
  ourAmountRial: m.ourAmountRial?.toString() ?? null,
  theirAmountRial: m.theirAmountRial?.toString() ?? null,
  details: m.details,
});

/** Amounts are rial, as the PSP's file and our ledger hold them, and named so: the API's toman does not apply to a bank file. */
export function toRunView(run: ReconciliationRun): RunView {
  return {
    runId: run.id,
    date: run.date,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt.toISOString(),
    settlementRows: run.settlementRows,
    matched: run.matched,
    mismatchCount: run.mismatches.length,
    mismatches: run.mismatches.map(mismatchView),
  };
}

/**
 * @class ReconciliationController
 * @description `POST /reconciliation/run` and `GET /reconciliation/runs/:id`, behind the internal key when one is set.
 * A run only reads and reports, so it needs no Idempotency-Key: repeating it makes another report, never a second effect.
 */
@Controller('reconciliation')
@InternalOnly()
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post('run')
  @IdempotencyExempt(
    'a run only reads and records a report: repeating it makes another report, never a second effect on money',
  )
  async run(@Body() dto: RunReconciliationDto): Promise<RunView> {
    return toRunView(await this.reconciliation.run(dto.date));
  }

  /** Unknown and malformed ids alike are 404. */
  @Get('runs/:id')
  async get(@Param('id') id: string): Promise<RunView> {
    const run = isUuid(id) ? await this.reconciliation.get(id) : null;
    if (!run) throw new AppError('NOT_FOUND', 'Reconciliation run not found');
    return toRunView(run);
  }
}
