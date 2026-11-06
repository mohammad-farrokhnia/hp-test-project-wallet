# Wallet

A wallet service with a double-entry ledger: users hold IRT (stored as rial) and USDT balances, deposit through a payment provider (PSP) and withdraw through a payout provider. Money only moves inside PostgreSQL transactions, and the providers are treated as untrusted: a callback never changes a balance, only our own follow-up lookup does.

**Stack:** 
- NestJS 11 
- TypeScript 
- PostgreSQL 17 (TypeORM, explicit SQL on money paths) 
- RabbitMQ (transactional outbox) 
- Node 22.

## Status

Every required part of the brief and every bonus part is implemented and tested.

| Part | Status |
| --- | --- |
| Wallet and double-entry ledger for IRT | Done (required) |
| IRT deposit through the PSP | Done (required) |
| IRT withdrawal to Sheba with the daily limit | Done (required) |
| Idempotency on every financial request | Done (required) |
| Manual credit by operations | Done (required) |
| Integration tests, including concurrent withdrawals across two instances | Done (required) |
| Design document, provider notes, Ambiguity #1, incident analysis | Done (required), in [docs/](docs/) |
| USDT balance, TRC20 withdrawal and fee | Done (bonus) |
| Transfers between users | Done (bonus) |
| Balance events through RabbitMQ with an idempotent consumer | Done (bonus) |
| Reconciliation with the PSP settlement file | Done (bonus) |
| End-to-end test on the full stack | Done (bonus) |
| Ambiguities #2 and #3, scalability analysis | Done (bonus) |

The test suite has 1,368 tests: 39 unit spec files, 42 integration spec files against real PostgreSQL and RabbitMQ, and one end-to-end suite against the compose stack.

### Not done, and how I would do it

| Item | How |
| --- | --- |
| `deposit.status.changed` and `withdrawal.status.changed` events. The routing keys are bound, but only `wallet.balance.changed` is emitted, which is what the brief asks for | One `outbox.add` beside each compare-and-set status update, in the same transaction, and a test per transition |
| Scheduled invariant check with alerting. `GET /internal/invariants` runs on demand only | A worker job every few minutes calling `InvariantsService.check()`, logging an `ALERT` and exporting a metric when `ok` is false |
| An API for the review queue (`needs_review` records) | A paginated `GET /internal/reviews` over the existing partial indexes, and a resolve action that records who resolved what |
| The `state_transitions` audit table and a restricted database role, both in the v1 design | One migration and one insert beside each status update; a role with `SELECT, INSERT` only on journals and postings |
| A fresh database per test run | Create and drop a uniquely named `_test` database in Jest's global setup, so suites never see each other's leftovers |

## Architecture in brief

One codebase and one image, started in one of three roles by `APP_ROLE`:

- **`api`**: HTTP. Two replicas behind nginx, reachable as `app:3000`.
- **`worker`**: consumers, outbox relay, schedulers. Two replicas. Its only controller is the probe pair below.
- **`all`**: both roles in one process, for local development.

Every role serves `GET /health` (liveness) and `GET /ready` (readiness: `200` when the database answers, `503 NOT_READY` when it does not).

PostgreSQL is the only source of truth; RabbitMQ only delivers. Every money change is one `READ COMMITTED` transaction that locks rows in a fixed order.

Design documents live in [docs/](docs/):

| File | Contents |
| --- | --- |
| [design.md](docs/design.md) | Architecture, ledger, request path |
| [modules.md](docs/modules.md) | Module responsibilities and process roles |
| [data-model.md](docs/data-model.md) | Every table, constraint and index |
| [state-machines.md](docs/state-machines.md) | Deposit and withdrawal transitions |
| [adr/](docs/adr/) | The 13 decision records |
| [overview.md](docs/overview.md) | Start here: flows, money model, guarantees and how they are tested, stack choices, known limitations |
| [running.md](docs/running.md) | Running the stack, every test tier, the simulator modes, the hardening tools, extending the code |
| [api/openapi.yaml](docs/api/openapi.yaml) | The API contract (imports into Postman, Insomnia or Swagger UI) |
| [provider-notes.md](docs/provider-notes.md) | Simulator behaviour observed and how it changed the design; evidence in [evidence/](docs/evidence/) |
| [ambiguities.md](docs/ambiguities.md) | The three deliberate ambiguities |
| [incident-analysis.md](docs/incident-analysis.md) | The negative-balance incident |
| [scalability.md](docs/scalability.md) | The first bottleneck at 50× load, with measurements |

## Quick start (Docker)

Prerequisites: Docker with Compose v2.24+. The provider simulator image is not on a registry; load it once from the kickoff kit:

```bash
docker load -i t103-simulator.tar.gz        # provides hamtapay/t103-simulator:1.0
docker compose up -d --build --wait         # postgres, rabbitmq, simulator, migrate, api x2, worker x2, nginx
curl localhost:3000/health                  # {"status":"ok"}
```

Stop with `docker compose down` (add `-v` to also delete the database and queue data).

| Service | Role |
| --- | --- |
| `app` | nginx, the public entry point (`localhost:3000`), round-robin over `api` |
| `api` ×2 / `worker` ×2 | the application image, one per `APP_ROLE` |
| `migrate` | one-shot: applies pending migrations, then exits |
| `postgres`, `rabbitmq` | data stores |
| `simulator` | the PSP and payout provider simulator (`SIM_CHAOS`: `off`, `default`, `hostile`) |

Postgres, RabbitMQ (AMQP and UI) and the simulator are published on `127.0.0.1` only. `.env.example` pins Postgres, RabbitMQ and the simulator (`SIMULATOR_PORT=8080`, which is where `PSP_BASE_URL` and `PAYOUT_BASE_URL` point), so a copy of it works from the host as it is; a spec keeps those values consistent. Set a port to `0` for any free one and find it with `docker compose port <service> <port>`.

The public entry point (nginx) is published on `127.0.0.1` too (`APP_BIND`), because with `INTERNAL_API_KEY` empty the `/internal/*` endpoints are open: only the machine itself can reach them. To publish the service on the network, set `INTERNAL_API_KEY` first, then `APP_BIND=0.0.0.0`.

Every long-running service has `restart: unless-stopped`, so a crashed API, worker or dependency comes back by itself. A container you stop yourself (`docker stop`, `docker kill`) stays stopped until you start it.

## Configuration

```bash
cp .env.example .env
```

`.env` is optional for Docker (every value has a default) and required to run the app or tests on your machine. Compose reads it too, so credentials, ports and limits are set in one place. Every variable is validated at startup and the app refuses to start on a missing or malformed one (`src/config/env.schema.ts`).

The database connection is built from `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`, so `POSTGRES_PORT` is the single port: compose publishes Postgres on it and the app connects to it. RabbitMQ works the same way: `RABBITMQ_HOST`, `RABBITMQ_PORT`, `RABBITMQ_USER` and `RABBITMQ_PASSWORD`, with `RABBITMQ_PORT` the AMQP port compose publishes and the app uses. The `*_BASE_URL` values in `.env` point at `localhost` for running on your machine. Inside Docker, compose supplies the container-network host and port itself, so those lines are ignored there.

## Running on your machine

```bash
nvm use                                    # Node 22 (.nvmrc)
npm install
docker compose up -d --wait postgres rabbitmq simulator   # dependencies only
npm run start:dev
```

Other scripts: `npm run build`, `npm run lint` (applies fixes), `npm run format`.

**After adding or changing a migration**, regenerate the query types and commit the result:

```bash
npm run db:types   # applies pending migrations to your dev DB, then writes src/database/db.types.ts
```

Repositories build SQL with `db(tx)` (Kysely, typed from that file) inside `TransactionRunner.run()`; see ADR-013.

## Running the tests

Unit tests need nothing. The database integration tests (`*.int.spec.ts`) run against a real PostgreSQL and use their **own database, `wallet_test`**, never your dev data. Create the test config once:

**1. Create `.env.test`** in the project root. It is git-ignored, like `.env`:

```dotenv
POSTGRES_DB=wallet_test
PSP_BASE_URL=http://localhost:8080
PAYOUT_BASE_URL=http://localhost:8080
PUBLIC_BASE_URL=http://localhost:3000
PAYOUT_WEBHOOK_SECRET=hamtapay-sim-secret
```

Host, port, user and password come from `POSTGRES_*` in your `.env`; only the database name is overridden. `POSTGRES_DB` **must end in `_test`**: the run refuses to start otherwise, because the tests truncate and drop tables.

**2. Start PostgreSQL and run:**

```bash
docker compose up -d --wait postgres
npm test
```

`wallet_test` is created automatically on the first run. Values in `.env.test` win over your shell and `.env`, so an exported dev `POSTGRES_DB` cannot leak into a test run.

If PostgreSQL is not running, the unit tests still pass and the integration suite fails with `ECONNREFUSED`. If `.env.test` is missing, the run stops with an error pointing here.

**Smoke run against the real PSP simulator (not part of `npm test`; needs the image from `docker load -i t103-simulator.tar.gz`):**

```bash
docker run --rm -p 8080:8080 -e SIM_CHAOS=hostile hamtapay/t103-simulator:1.0
SMOKE_PSP_URL=http://127.0.0.1:8080 npx jest deposit.smoke
```

Run it with `SIM_CHAOS=off` and `hostile`. Callbacks go nowhere in this run, so each payment is found by polling alone, through the simulator's 503s. Without `SMOKE_PSP_URL` the spec is skipped.

**Performance check (about a minute, not part of `npm test`):**

```bash
npm run test:perf
```

It seeds a user with 1,000,000 postings inside a transaction that is rolled back, walks to page 1,000 of `GET /wallets/:userId/ledger` through real cursors, and fails if that page takes 50 ms or more, or if its plan sorts or scans instead of walking an index.

**RabbitMQ restart check (restarts the compose broker, so it runs alone):**

```bash
npm run test:chaos
```

A sweeper and a job consumer run against the real broker; one job is handled, `docker compose restart rabbitmq` runs, and a row that comes due meanwhile must still be queued and handled once the broker is back.

**Or run everything inside Docker**, with no local setup (uses `wallet_test` in the compose Postgres):

```bash
docker compose --profile test run --rm test
```
## Conventions

- **No floats for money.** Lint rejects `parseFloat`, `Number(...)` and `toFixed`. Use `bigint`.
- **Amounts are `Money`** (`src/common/money`): `bigint` minor units, rial for IRR and 10⁻⁶ for USDT. Parse client input with `parseApiAmount('IRT' | 'USDT', string)` (whole toman, ×10 to rial; USDT up to 6 decimals), format with `formatApiAmount`, and talk to providers with `toProviderAmount` / `parseProviderAmount`. Strings only: a JS number is rejected.
- **Errors are `AppError(code)`** from the catalog in `src/common/errors`; the status comes from the catalog and every response is `{code, message}`. Unexpected errors become `INTERNAL_ERROR` with no detail and are logged with the `X-Request-Id`. Logs are JSON (`LOG_LEVEL`), never include request headers, and `GET /health` is not access-logged.
- **Schema changes are migrations only.** `synchronize` stays off.
- **Raw `manager.query()` returns BIGINT as strings.** Wrap with `BigInt(...)`; entities use `bigintTransformer`.
- **A transaction function may be re-run** after a deadlock, so it must not call providers or publish messages. Those go through the outbox.
