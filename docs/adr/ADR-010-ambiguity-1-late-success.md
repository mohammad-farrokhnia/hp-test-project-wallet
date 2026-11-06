# ADR-010: Ambiguity #1: correct the record, claw back, record debt

## Context

A withdrawal was declared failed after a silence, the user withdrew the same money again, and now the payout service says the first one succeeded too. Money has left twice; the user's balance can't cover the first one again. Our design (ADR-3) stops this arising from timeouts, but a provider contradiction, an old record or a manual mistake can still produce it.

## Options


| Option                                                                                                                                    | For                                                                  | Against                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Keep FAILED and ignore                                                                                                                    | Nothing to build                                                     | The books lie: money left and nobody owes it                         |
| Let AVAILABLE go negative                                                                                                                 | Simple                                                               | Breaks the core rule "balance never negative" and the database CHECK |
| Write it off as a company loss                                                                                                            | Kind to the user                                                     | Loses money silently; no audit                                       |
| **Correct the status to SUCCEEDED; claw back what's available; record the rest as DEBT; block withdrawals until repaid; flag for review** | Books match reality; balance stays ≥ 0; debt visible and collectable | A final status changes in this one audited case                      |




## Decision

Transition W12 books a `WITHDRAWAL_LATE_SUCCESS` journal: PAYOUT_CLEARING +x, AVAILABLE −min(available, x), DEBT −rest. The withdrawal becomes `SUCCEEDED` with `late_success_at` set and is flagged `LATE_SUCCESS` with an alert. Every later credit repays DEBT first, so the user can't withdraw while in debt. Collecting beyond that is an ops and legal process outside the system.

**The earlier decision to change:** declaring the withdrawal FAILED because the provider was silent. With the same requestId on every retry and the money kept frozen until a definitive answer (ADR-3), the second withdrawal would have been refused for insufficient funds.

## Consequences

**Good**

- The ledger tells the truth, and the database rule "no negative balance" still holds.
- The debt is visible on the wallet (`debt` field) and repays itself from the next deposit.

**Cost**

- One case where a final status changes. It is visible through `late_success_at`, the `LATE_SUCCESS` review flag, an alert in the log, and the `WITHDRAWAL_LATE_SUCCESS` journal that references the withdrawal.
- A human must follow up with the customer.

