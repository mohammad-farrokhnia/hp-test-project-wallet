# Wallet

A wallet service with a double-entry ledger: users hold IRT (stored as rial) and USDT balances, deposit through a payment provider (PSP) and withdraw through a payout provider. Money only moves inside PostgreSQL transactions, and the providers are treated as untrusted: a callback never changes a balance, only our own follow-up lookup does.

**Stack:** 
- NestJS 11 
- TypeScript 
- PostgreSQL 17 (TypeORM, explicit SQL on money paths) 
- RabbitMQ (transactional outbox) 
- Node 22.

## Status

in progrees ...

## Architecture in brief

One codebase and one image, started in one of two roles by `APP_ROLE`:

- **`api`**: HTTP. Two replicas behind nginx, reachable as `app:3000`.
- **`worker`**: consumers, outbox relay, schedulers. Two replicas.

PostgreSQL is the only source of truth; RabbitMQ only delivers. Every money change is one `READ COMMITTED` transaction that locks rows in a fixed order.

Design documents live in [docs/](docs/):

| File | Contents |
| --- | --- |
| [design.md](docs/design.md) | Architecture, ledger, request path |
| [modules.md](docs/modules.md) | Module responsibilities and process roles |
| [data-model.md](docs/data-model.md) | Every table, constraint and index |
| [state-machines.md](docs/state-machines.md) | Deposit and withdrawal transitions |
| [adr/](docs/adr/) | The 13 decision records |

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

Postgres, the RabbitMQ UI and the simulator are published on `127.0.0.1` only. Find a port with `docker compose port postgres 5432`, or pin it with `POSTGRES_PORT`, `RABBITMQ_UI_PORT` or `SIMULATOR_PORT` in `.env`.

## Configuration

```bash
cp .env.example .env
```

`.env` is optional for Docker (every value has a default) and required to run the app or tests on your machine. Compose reads it too, so credentials, ports and limits are set in one place. Every variable is validated at startup and the app refuses to start on a missing or malformed one (`src/config/env.schema.ts`).

`DATABASE_URL`, `RABBITMQ_URL` and the `*_BASE_URL` values in `.env` point at `localhost` for running on your machine. Inside Docker, compose builds the container-network versions itself, so those lines are ignored there. If you change `POSTGRES_PORT`, change the port in `DATABASE_URL` to match.

## Running on your machine

```bash
nvm use                                    # Node 22 (.nvmrc)
npm install
docker compose up -d --wait postgres rabbitmq simulator   # dependencies only
npm run start:dev
```

Other scripts: `npm run build`, `npm run lint` (applies fixes), `npm run format`.

## Running the tests

Unit tests need nothing. The database integration tests (`*.int.spec.ts`) run against a real PostgreSQL and use their **own database, `wallet_test`**, never your dev data. Create the test config once:

**1. Create `.env.test`** in the project root. It is git-ignored, like `.env`:

```dotenv
DATABASE_URL=postgres://wallet:wallet@localhost:5432/wallet_test
RABBITMQ_URL=amqp://guest:guest@localhost:5672
PSP_BASE_URL=http://localhost:8080
PAYOUT_BASE_URL=http://localhost:8080
PUBLIC_BASE_URL=http://localhost:3000
PAYOUT_WEBHOOK_SECRET=hamtapay-sim-secret
```

Use the same user, password and port as `POSTGRES_*` in your `.env`. The database name **must end in `_test`**: the run refuses to start otherwise, because the tests truncate and drop tables.

**2. Start PostgreSQL and run:**

```bash
docker compose up -d --wait postgres
npm test
```

`wallet_test` is created automatically on the first run. Values in `.env.test` win over your shell and `.env`, so an exported dev `DATABASE_URL` cannot leak into a test run.

If PostgreSQL is not running, the unit tests still pass and the integration suite fails with `ECONNREFUSED`. If `.env.test` is missing, the run stops with an error pointing here.

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
