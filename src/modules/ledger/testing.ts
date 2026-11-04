import { LedgerService } from './ledger.service';
import { AccountsRepository } from './repositories/accounts.repository';
import { JournalsRepository } from './repositories/journals.repository';
import { LedgerChecksRepository } from './repositories/ledger-checks.repository';

/**
 * @function newLedgerService
 * @description A `LedgerService` wired with its real repositories, for tests that run without Nest.
 * @returns the service
 */
export function newLedgerService(): LedgerService {
  return new LedgerService(
    new AccountsRepository(),
    new JournalsRepository(),
    new LedgerChecksRepository(),
  );
}
