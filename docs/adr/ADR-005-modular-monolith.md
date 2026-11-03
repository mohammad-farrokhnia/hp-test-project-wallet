# ADR-005: A modular monolith with api and worker roles

## Context

The brief speaks of services (wallet, deposit, transfer, withdrawal, operations). Withdrawals must change idempotency, limit, frozen funds and outbox atomically; transfers must move two balances atomically. The build has four days and one developer.

## Options


| Option                                                                                               | For                                                                           | Against                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Microservices, a database each                                                                       | Independent deploys and scaling; isolation                                    | Atomic operations become sagas with compensations and visible in-between states; network failures between our own services; far more to build and test |
| Microservices on one shared database                                                                 | Looks modular                                                                 | The coupling of a monolith plus network failures                                                                                                       |
| **Modular monolith: one codebase, modules own their tables, one image run as** `api` **or** `worker` | Each money operation is one ACID transaction; fast to build; one test harness | One blast radius; boundaries enforced by lint, not the network                                                                                         |




## Decision

One NestJS application with a module per business area. Each module owns its tables and is reached only through its exported service (a lint rule enforces this). The same image runs as `api` (2 replicas behind nginx `app:3000`) or `worker` (2 replicas).

## Consequences

**Good**

- Every invariant is one database transaction.
- Horizontal scaling where it matters: stateless API and worker replicas.
- Modules can be extracted later along their table boundaries.

**Cost**

- A compromised process holds the whole database credential (mitigated: append-only role for ledger tables).
- Modules can't be deployed separately.

