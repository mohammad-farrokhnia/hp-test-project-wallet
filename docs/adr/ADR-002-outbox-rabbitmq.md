# ADR-002: Asynchronous work through a transactional outbox and RabbitMQ

## Context

Provider calls must happen outside the request transaction, on worker instances, and survive crashes. The brief requires that an event is not lost if the service dies right after the database commit, and that losing Redis or the broker loses no critical data.

## Options


| Option                                             | For                                                                                                                            | Against                                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Call the provider inside the request               | Simple                                                                                                                         | Holds locks during slow, unreliable HTTP; a timeout leaves the outcome unknown inside a transaction                                                    |
| Publish to the broker right after commit           | Low latency                                                                                                                    | Dual write: commit OK + publish lost = job lost; publish OK + commit failed = ghost job                                                                |
| PostgreSQL rows as the queue (SKIP LOCKED polling) | No extra infrastructure; fully transactional                                                                                   | Build retries, fan-out and back-pressure yourself; polling load grows with volume; no event fan-out for the bonus                                      |
| BullMQ on Redis                                    | Native NestJS support; retries, backoff, delayed and repeatable jobs and rate limiting built in; very low latency; simple setup | Job state lives in Redis; durability depends on its persistence settings, so the database must be the truth anyway, and the bonus still needs a broker |
| **Outbox table + relay → RabbitMQ quorum queues**  | Atomic with the business change; competing consumers; delivery limits and dead-lettering; the same broker carries bonus events | One more container and a relay process                                                                                                                 |




## Decision

Business transactions write outbox rows. A relay publishes them with publisher confirms. Messages carry ids only, and consumers ack after their own transaction commits. Retry timing lives in each row's `next_check_at`, and a sweeper republishes due work, so RabbitMQ never has to remember anything. Redis is not used at all.

## Consequences

**Good**

- No lost or ghost jobs: the job exists exactly when the state change committed.
- Losing RabbitMQ delays work but loses nothing; the sweeper rebuilds the queue from rows.
- Several workers share the load safely.

**Cost**

- Delivery is at least once, so every handler must be idempotent (state guards, unique journals, inbox).
- Two mechanisms to explain: relay and sweeper.
- One more container in compose.

