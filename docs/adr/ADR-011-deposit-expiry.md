# ADR-011: Deposits expire after 24 hours in INIT; later payments are never verified

## Context

A deposit that was really paid must be credited, and never for more than was paid. The probe showed simulator payments never expire in INIT (≥ 95 simulated minutes), and that a PAID payment nobody verifies is REVERSED to the payer within roughly 10–29 minutes.

## Options


| Option                                                                         | For                                                                                          | Against                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Never expire; poll forever                                                     | Never misses a payment                                                                       | Records never reach a final status; polling grows without bound |
| Expire after 30 minutes                                                        | Tidy                                                                                         | A slow payer is refunded instead of credited                    |
| Credit late payments after expiry                                              | Always credits                                                                               | A final FAILED becomes SUCCEEDED                                |
| **Expire after 24 h only if the PSP still says INIT; never verify after that** | Every deposit becomes final; paid money is always either credited or returned by the gateway | A payer using a day-old link is refunded, not credited          |




## Decision

A PENDING deposit is polled (15 s, 15 s, 30 s, then every minute to 30 min, then every 5 min). At `expires_at` (24 h) the sync expires it only if the PSP status is still INIT. A payment arriving later is never verified, so the gateway reverses it to the payer; the deposit is flagged `LATE_PAYMENT_AFTER_EXPIRY` for support.

## Consequences

**Good**

- No paid money is ever kept without credit.
- A bounded amount of polling per deposit.

**Cost**

- A very late payer waits for the gateway's automatic refund.

