# ADR-006: Ledger: journals with signed postings, materialised balances, invariants in the database

## Context

Every money movement must be double-entry, immutable, corrected only by new entries, and the history must stay fast for users with millions of entries. Some events touch three accounts (USDT fee, debt repayment).

## Options


| Option                                                                       | For                                        | Against                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| One `transactions` table with from/to                                        | Simple                                     | Only two legs: can't express a fee or a debt split         |
| Debit/credit columns with normal sides                                       | Accountant-friendly                        | Two columns and a sign rule to reason about; harder to sum |
| **Journals + signed postings that sum to zero**                              | Any number of legs; one SUM proves balance | Accountants need a derived debit/credit view               |
| Balance computed by summing on read                                          | Always correct                             | O(n) per read and under the lock                           |
| **Balance materialised on the account row, updated in the same transaction** | O(1) reads and checks                      | Every posting updates a row                                |




## Decision

A journal is one business event; its postings carry signed amounts and must sum to zero, which a deferred constraint trigger checks at commit. Journals and postings can't be updated or deleted. Each account row holds its balance, updated in the same transaction, and every posting stores `balance_after`. `UNIQUE (kind, ref)` stops double booking, and a partial unique index makes a withdrawal either settled or released, never both.

## Consequences

**Good**

- The database itself proves the books balance and nothing was booked twice.
- Fast balances and fast keyset history.
- An invariant job can compare balances with postings at any time.

**Cost**

- More rows per event; triggers that must be explained.
- Hot system-account rows at very high volume (ADR-1).

