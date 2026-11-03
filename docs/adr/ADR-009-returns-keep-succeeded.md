# ADR-009: A bank return keeps the withdrawal SUCCEEDED

## Context

The payout service can report RETURNED (`ACCOUNT_CLOSED`) minutes after SUCCEEDED (PAY-07). The brief requires the money to become available again if a withdrawal "was not done **or** was returned", and allows only SUCCEEDED and FAILED as final statuses.

## Options


| Option                                                                                        | For                                                                                                    | Against                                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| SUCCEEDED → FAILED (reason RETURNED)                                                          | One final status meaning "user got nothing"                                                            | A final status flips; clients that already reported success are contradicted |
| A third final status RETURNED                                                                 | Precise                                                                                                | Outside the contract's two final statuses                                    |
| **Stay SUCCEEDED; book the return as its own journal with** `returnedAt` **/** `returnReason` | Final statuses never change; mirrors a bank statement (debit, then a credit "return of transaction x") | Clients must read `returnedAt`                                               |




## Decision

A return is a new money event, not a status change. The withdrawal stays `SUCCEEDED`. A `WITHDRAWAL_RETURN` journal (PAYOUT_CLEARING → AVAILABLE, amount only; the USDT fee is kept because the transfer did execute) references it, and `returned_at` and `return_reason` are set. Successful withdrawals are watched for returns for 24 hours. The daily limit isn't given back.

## Consequences

**Good**

- The "only forward" rule has no exception in normal operation.
- The ledger history shows the return as its own line, referencing the withdrawal.

**Cost**

- Reports of successful payouts must net out returns.

