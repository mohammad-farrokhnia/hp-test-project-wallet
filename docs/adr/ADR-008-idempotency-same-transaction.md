# ADR-008: Idempotency: key, effect and response in one transaction

## Context

Repeating a request with the same Idempotency-Key, one after another or at the same time, must take effect once. The PSP doesn't de-duplicate `orderId`, and `POST /deposits` must call it synchronously to return the payment link.

## Options


| Option                                                                                                             | For                                                                              | Against                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Keys in Redis                                                                                                      | Fast                                                                             | Not atomic with the business change; lost on failover                      |
| Write the key in its own transaction, then do the work                                                             | Simple                                                                           | A crash between them leaves a key with no effect, or an effect with no key |
| Business unique constraints only                                                                                   | Already there                                                                    | Can't replay the original response; a second request gets an error instead |
| **Key row, business effect and stored response in one transaction; a leased two-phase variant for deposit create** | Exactly one effect under concurrency and crashes; twins replay the same response | Deposits need the lease path                                               |




## Decision

The key is the primary key of `idempotency_keys`, scoped globally. It is fingerprinted with the route and canonical body. It is inserted in the same transaction as the effect and the stored response. A concurrent twin blocks on the key until the first commits, then replays; if the wait exceeds `lock_timeout` it gets 409. A different body gets 422. Stored: 2xx and state-dependent 422s. Deposit create uses a 30-second lease so a crashed attempt can be resumed with the same key.

## Consequences

**Good**

- Retries are always safe, including the network-dropped-the-201 case.
- No stuck keys on single-transaction endpoints.

**Cost**

- The key row lock is held for the whole transaction.
- Deposit create has two phases and a lease to explain.
- Keys are kept 7 days; a later retry re-executes, and business uniqueness still prevents double money.

