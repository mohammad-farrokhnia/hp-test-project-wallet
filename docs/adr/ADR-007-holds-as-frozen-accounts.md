# ADR-007: Funds on hold as FROZEN ledger accounts

## Context

From request until a final status, the withdrawn amount (plus fee) must not be withdrawable or transferable, and it must come back if the payout fails.

## Options


| Option                                                             | For                                                                                   | Against                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Reservation table outside the ledger (available = balance − holds) | Fewer journals                                                                        | Holds aren't double-entry; invariants and history ignore them; "available" becomes a computed query |
| A status flag on the balance                                       | Trivial                                                                               | No audit trail; can't hold several withdrawals at once                                              |
| **A FROZEN account per user and currency, moved by journals**      | Holds are audited, part of every invariant, visible in history; available is a column | Two journals per withdrawal                                                                         |




## Decision

Each user has AVAILABLE, FROZEN and DEBT accounts per currency. A request moves amount + fee from AVAILABLE to FROZEN; success moves it from FROZEN to PAYOUT_CLEARING and FEE_REVENUE; failure or cancellation moves it back.

## Consequences

**Good**

- "available" in the API is a single column read.
- The invariant FROZEN = sum of open withdrawals is checkable at any time.

**Cost**

- The history shows a freeze line and a settle line per withdrawal (the `bucket` field tells them apart).

