# ADR-001: Concurrency control with PostgreSQL row locks

## Context

Up to 100 withdrawals for one balance can arrive at the same time, on different instances. The balance must never go negative and the 200,000,000 toman daily limit must hold. The incident in the brief shows what happens when the check-then-act is guarded by a Redis lock that expires under load: two instances both pass the check.

## Options


| Option                                                                             | For                                                                                                                               | Against                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Redis distributed lock                                                             | Fast; familiar                                                                                                                    | Lock and data live in different systems; a TTL can expire mid-transaction under load, giving two holders (the incident). Needs fencing tokens the database would have to check anyway |
| Optimistic version column + retry                                                  | No waiting                                                                                                                        | 100 requests on one row: 99 conflict and retry repeatedly; tail latency and wasted work                                                                                               |
| SERIALIZABLE isolation + retry                                                     | Correct by construction                                                                                                           | Same retry storm under contention; harder to reason about and to explain                                                                                                              |
| Advisory locks                                                                     | Flexible keys                                                                                                                     | Not tied to rows; easy to forget one path; integer key hashing                                                                                                                        |
| **Row locks (**`SELECT … FOR UPDATE`**) in a fixed order, plus CHECK constraints** | One arbiter shared by every instance; the check runs after the lock on the newest committed value; constraints catch any code bug | Requests for the same user wait for each other                                                                                                                                        |




## Decision

Every money change runs in one READ COMMITTED transaction that locks the user's account rows (and the daily-usage row) with `SELECT … FOR UPDATE`, always in the global lock order: idempotency key → business row → accounts by id → daily usage. `lock_timeout = 3 s`. A deadlock or serialization failure retries the whole transaction up to three times. `CHECK (balance ≥ 0)` and `CHECK (used ≤ cap)` back up the code.

## Consequences

**Good**

- Correct for any number of instances; nothing in memory or Redis matters.
- The database refuses an overdraft even if the code has a bug.
- Easy to prove: the concurrency suite runs 100 requests across two app instances.

**Cost**

- One user's requests run one after another (a few milliseconds each).
- A single very busy wallet tops out at a few hundred requests per second.
- System accounts touched on every settlement become hot rows at very high volume.

