# Running, testing and extending the service

Everything here assumes the repository root as the working directory. Commands are given for a POSIX shell (Linux, macOS, WSL, Git Bash); where Windows PowerShell differs, the PowerShell form follows.

## 1. Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Docker with Compose | Engine 24+, Compose v2.24+ | Everything |
| The simulator image | `hamtapay/t103-simulator:1.0` | The PSP and payout provider |
| Node.js | 22 (see `.nvmrc`) | Running the app or the tests outside Docker, and the hardening tools |

```bash
docker load -i t103-simulator.tar.gz
```

About 3 GB of memory for Docker is enough for the whole stack.

## 2. Run the whole system

```bash
docker compose up -d --build --wait
curl localhost:3000/health          # {"status":"ok"}
curl localhost:3000/ready           # {"status":"ok","checks":{"database":"up"}}
```

This starts PostgreSQL, RabbitMQ, the simulator, a one-shot `migrate` container, two `api` replicas, two `worker` replicas and nginx as `app` on `127.0.0.1:3000`. No `.env` is needed: every value has a working default.

| Service | Purpose | Reach it from the host |
|---|---|---|
| `app` (nginx) | Public entry, round-robin over the API replicas | `http://localhost:3000` |
| `api` ×2 | HTTP API, PSP callback, payout webhook | through `app` |
| `worker` ×2 | Outbox relay, job consumers, sweeper, retention jobs | none |
| `postgres` | The database | `docker compose port postgres 5432` |
| `rabbitmq` | Broker and management UI (guest/guest) | `docker compose port rabbitmq 15672` |
| `simulator` | PSP and payout provider | `http://localhost:8080` when `SIMULATOR_PORT=8080` |

Stop with `docker compose down`. Add `-v` to delete the database and broker volumes as well.

**Simulator modes.** `SIM_CHAOS` selects `off`, `default` or `hostile`; `SIM_TIME_SCALE` speeds the simulator's clock up.

```bash
SIM_CHAOS=hostile docker compose up -d --wait          # PowerShell: $env:SIM_CHAOS='hostile'; docker compose up -d --wait
```

**Logs.** `docker compose logs -f api worker`. Logs are JSON lines with `requestId`, `withdrawalId` or `depositId`. Alerts (stuck withdrawals, late successes, unverified deposits) are logged at `error` level and start with `ALERT`.

**Internal endpoints.** With `INTERNAL_API_KEY` empty (the default), `/internal/*` and `/reconciliation/*` are open and nginx is bound to `127.0.0.1`. To publish the service on a network, set `INTERNAL_API_KEY` and then `APP_BIND=0.0.0.0`; clients then send `X-Internal-Api-Key`.

## 3. A walk through the API

```bash
# credit a user (the operations endpoint)
curl -s -X POST localhost:3000/internal/adjustments -H 'content-type: application/json' -H 'Idempotency-Key: adj-1' \
  -d '{"userId":"alice","currency":"IRT","amount":"1000000","reason":"opening balance"}'

# withdraw to a Sheba IBAN
curl -s -X POST localhost:3000/withdrawals -H 'content-type: application/json' -H 'Idempotency-Key: wd-1' \
  -d '{"userId":"alice","currency":"IRT","amount":"150000","destination":"IR820540102680020817909002"}'

curl -s localhost:3000/withdrawals/<withdrawalId>        # PENDING → SUBMITTING → PROCESSING → SUCCEEDED
curl -s localhost:3000/wallets/alice                     # available, frozen, total, debt per currency
curl -s 'localhost:3000/wallets/alice/ledger?limit=20'   # newest first; pass nextCursor as cursor

# deposit: create, pay on the simulator, watch it become SUCCEEDED
curl -s -X POST localhost:3000/deposits -H 'content-type: application/json' -H 'Idempotency-Key: dep-1' \
  -d '{"userId":"alice","amount":"250000"}'
curl -s -X POST localhost:8080/psp/pay/<token> -H 'content-type: application/json' -d '{"result":"success"}'
curl -s localhost:3000/deposits/<depositId>

# the books
curl -s localhost:3000/internal/invariants               # "ok": true
```

The full contract is in `docs/api/openapi.json`. Postman, Insomnia and Swagger UI all import it directly.

## 4. Run the application outside Docker

```bash
cp .env.example .env
nvm use && npm install
docker compose up -d --wait postgres rabbitmq simulator    # dependencies only
npm run start:dev                                          # APP_ROLE from .env; "all" runs API and worker in one process
```

`.env.example` publishes PostgreSQL, RabbitMQ and the simulator on fixed host ports, and the app's `*_BASE_URL` values point at them. Every variable is validated at startup (`src/config/env.schema.ts`); the app refuses to start on a missing or malformed one.

## 5. Tests

### Tiers

| Tier | Files | Needs | Command |
|---|---|---|---|
| Unit | `*.spec.ts` (39 files) | nothing | `npm test` runs them with the rest |
| Integration | `*.int.spec.ts` (42 files) | PostgreSQL and RabbitMQ | `npm test` |
| End to end | `src/e2e/full-stack.e2e.spec.ts` | the full compose stack | `docker compose --profile test run --rm test` |
| History performance | `history.perf.int.spec.ts` | PostgreSQL | `npm run test:perf` |
| Broker restart | `broker-restart.int.spec.ts` | the compose RabbitMQ | `npm run test:chaos` |
| PSP smoke | `deposit.smoke.int.spec.ts` | the real simulator | see below |

### Everything inside Docker (no local Node needed)

```bash
docker compose --profile test run --rm test
```

This starts the stack, waits for it to be healthy, and runs every suite, including the end-to-end journey (deposit, pay, withdraw, check the books) through nginx and the real simulator.

### On the host

Create `.env.test` once. It is git-ignored and its values win over `.env` and the shell:

```dotenv
POSTGRES_DB=wallet_test
PSP_BASE_URL=http://localhost:8080
PAYOUT_BASE_URL=http://localhost:8080
PUBLIC_BASE_URL=http://localhost:3000
PAYOUT_WEBHOOK_SECRET=hamtapay-sim-secret
```

`POSTGRES_DB` must end in `_test`; the run refuses to start otherwise, because the tests truncate tables. The database is created on the first run. Then:

```bash
docker compose up -d --wait postgres rabbitmq
npm test                                   # about 1,370 tests, 1.5 to 3 minutes
npx jest src/modules/withdrawal            # one folder
npx jest -t "never overdraw"               # by test name
```

The integration suites share `wallet_test` and leave committed rows behind. Suites that sweep due work take a PostgreSQL advisory lock (`src/database/int-testing.ts`) so they do not run against each other. To start from an empty test database: `docker compose exec postgres dropdb -U wallet wallet_test`.

### Special runs

```bash
npm run test:perf          # 1,000,000 postings for one user; page 1,000 of the history must take < 50 ms and use the index
npm run test:chaos         # restarts the compose RabbitMQ in the middle of a run; queued work must survive
npm run test:e2e           # needs E2E_BASE_URL=http://localhost:3000 and E2E_SIMULATOR_URL=http://localhost:8080
```

These scripts set the variable in POSIX syntax. In PowerShell run the underlying command instead:

```powershell
$env:PERF='1';  npx jest --runInBand src/modules/wallet/history.perf
$env:CHAOS='1'; npx jest --runInBand src/modules/scheduler/broker-restart
```

**PSP smoke run against the real simulator** (polling only; the simulator's callbacks cannot reach a test process):

```bash
docker run --rm -p 8080:8080 -e SIM_CHAOS=hostile hamtapay/t103-simulator:1.0
SMOKE_PSP_URL=http://127.0.0.1:8080 npx jest deposit.smoke
```

### Lint and type check

```bash
npx eslint "src/**/*.ts"        # npm run lint does the same and applies fixes
npx tsc --noEmit
```

Lint rejects `parseFloat`, `Number(...)` and `toFixed` (no floats on money) and ORM `save()` (explicit SQL on money paths).

## 6. Hardening tools and benchmarks

The scripts in `tools/hardening/` attack a running stack. They are not part of `npm test`. Start the stack first with `docker compose up -d --build --wait`.

| Script | What it does | Time |
|---|---|---|
| `node tools/hardening/fuzz.mjs` | About 220 malformed or hostile requests: bad JSON, wrong types, overflowing amounts, injection strings, oversized bodies, bad signatures, idempotency abuse. Passes when there is no 5xx and nothing is accepted that must be refused | under a minute |
| `node tools/hardening/chaos.mjs A B C D E F G H I J` | Kills or restarts the API, workers, PostgreSQL, RabbitMQ and the simulator under load; sends forged and out-of-order pushes; races withdrawals; runs USDT, transfers and reconciliation end to end. Checks one effect per key, no double credit, invariants, and that everything reaches a final state | about 20–30 minutes |
| `node tools/hardening/bench.mjs [seconds] [clients]` | Closed-loop load: adjustments, withdrawals of distinct users, withdrawals of one hot user, then the drain of the outbox and payout pipeline | about 1 minute |
| `node tools/hardening/capacity.mjs [scenario ...]` | Open-loop capacity test: raises the request rate step by step per scenario (reads, withdraw, transfer, hot, adjust, deposit, mixed) until the p95 SLO, the error budget or the achieved rate fails; samples container CPU and PostgreSQL lock waits; checks the invariants after each scenario. Prints the highest rate each scenario sustains | 15–25 minutes for all scenarios |
| `node tools/hardening/relay-bench.mjs [rows]` | Outbox rows published per second with one relay and with two | about 1 minute |
| `node tools/hardening/publish-bench.mjs [messages]` | Raw RabbitMQ publish rate with confirms, one at a time and pipelined | seconds |

Run the benchmarks with the simulator in `off` mode so provider chaos does not distort the numbers:

```bash
SIM_CHAOS=off docker compose up -d --wait
node tools/hardening/bench.mjs 15 32
```

`chaos.mjs` recreates the simulator in the mode each scenario needs and relies on the default compose project name (`wallet`). The results I recorded are in `docs/scalability.md`.

## 7. Database work

```bash
docker compose exec postgres psql -U wallet -d wallet           # a shell on the dev database
docker compose run --rm migrate                                   # apply pending migrations
npm run db:types                                                  # after adding a migration: regenerate src/database/db.types.ts
```

Migrations live in `src/database/migrations/`, numbered, forward-only and written in raw SQL. Never edit one that has been applied; add a new one. `synchronize` is off.

## 8. Extending the service

The code is arranged so that each kind of change touches a known, small set of files.

| Change | Files to touch | Tests to add |
|---|---|---|
| A new currency | `common/money/currency.ts` (code, API code, scale); `withdrawal/domain/withdrawal-policy.ts` (minimum, fee, destination type, limit rule); the payout client's amount formatting; a migration that widens the currency CHECK constraints (they are listed in migrations 0001, 0003, 0005, 0011 and 0012) and seeds the system accounts for it | `money.spec.ts`, `withdrawal-policy.spec.ts`, one withdrawal integration test |
| A new withdrawal or deposit status | The transition table in `domain/*-state-machine.ts`; the status CHECK in a migration; `state-machines.md`; the OpenAPI enum | One row in the state-machine spec |
| A new provider | A new adapter implementing `PspClient` or `PayoutClient` (`integrations/*/*.port.ts`), bound in the provider module. Services and state machines do not change | The adapter's classifier spec, and a fake server for its quirks |
| A new background job | A queue name in `messaging/topology.ts`; a handler implementing `JobHandler`; register it where the app is assembled (`app.module.ts`); if it is time-driven, a `DueWorkSource` for the sweeper | A handler integration test |
| A new balance-changing operation | A journal kind in `ledger/domain/journal.ts` and in the journals CHECK; call `LedgerService.post` inside the use case's transaction. Never update a balance anywhere else | A ledger test and the use case's integration test |
| A new financial endpoint | Use `@FinancialPost()` so the `Idempotency-Key` is required, and claim the key inside the business transaction. A route audit test fails if a `POST` is neither financial nor explicitly exempt | Replay, reuse and concurrent-twin tests |

Rules that keep the money correct, whatever the change:

- Never call a provider or publish to RabbitMQ inside a database transaction. Write to the outbox instead.
- A transaction function may run more than once after a deadlock retry, so it must have no side effects outside the database.
- Every status change is a compare-and-set on the expected status.
- Amounts are `Money` (`bigint`), parsed from strings at the edge.
