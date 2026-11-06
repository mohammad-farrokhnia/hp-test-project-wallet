# Project overview

This document is the entry point for a reviewer. It explains what the service does, how money flows through it, how each guarantee is enforced and tested, why I chose this stack, and the limitations I know about. The detailed documents it refers to are listed at the end.

## 1. What the service does

A crypto exchange holds IRT (toman) and USDT balances for its users. A user deposits IRT through a payment gateway (PSP), transfers to another user, and withdraws IRT to a Sheba IBAN or USDT to a TRC20 address through a payout provider. The operations team can credit a user manually with a reason, and can reconcile the PSP's daily settlement file against our records.

The central requirements are that no rial is lost, no withdrawal is paid twice, and no balance goes negative, even with concurrent and duplicated requests and with external services that cannot be trusted. Every design decision below comes back to those three.

## 2. Runtime topology

```
client ──► app :3000 (nginx) ──► api ×2  (APP_ROLE=api: HTTP, PSP callback, payout webhook)
                                    │
                                    ▼
                               PostgreSQL 17  ◄── the only source of truth
                                    ▲
                                    │
           RabbitMQ 4 ◄──────── worker ×2  (APP_ROLE=worker: outbox relay, job consumers, sweeper, retention jobs)
                                    │
                                    ▼
                            simulator :8080 (PSP + payout; callbacks and webhooks go back to app:3000)
```

One codebase and one Docker image, started in a role by `APP_ROLE` (`api`, `worker`, or `all` for local development). `migrate` is a one-shot container that applies migrations before the API and workers start. All instances are stateless; nothing about money is held in memory between requests.

PostgreSQL holds every fact. RabbitMQ only delivers work and events: every message is written first to an `outbox` table in the same transaction as the change it describes, and every scheduled retry is a `next_check_at` column. If the broker loses all its data, the relay and the sweeper rebuild everything from the database.

## 3. Modules

| Module | Owns | Responsibility |
|---|---|---|
| ledger | accounts, journals, postings | The only writer of money: `LedgerService.post(tx, journal)` locks, validates, appends postings and updates balances |
| wallet | none | Balances and keyset-paginated history (reads only) |
| idempotency | idempotency_keys | Claim, fingerprint, replay; 7-day retention |
| deposit | deposits | Create through the PSP, callback intake, `deposit.sync`, expiry and watchdog |
| withdrawal | withdrawals, payout_attempts, withdrawal_daily_usage | Request, limits, cancel, `withdrawal.submit` and `.sync`, webhook intake, escalation |
| transfer | transfers | User-to-user transfer (bonus) |
| operations | adjustments, reconciliation_runs, reconciliation_mismatches | Manual credit, invariant check, settlement reconciliation (bonus) |
| messaging | outbox, inbox | Transactional outbox, relay, RabbitMQ topology, consumer base, inbox de-duplication |
| notification | notifications | Consumer of balance events (bonus) |
| scheduler | none | Sweeper that turns due rows into jobs |
| integrations | inbound_events | PSP and payout HTTP clients, outcome classification, HMAC verification, raw record of every callback and webhook |

A module never reads another module's tables; it calls the other module's exported service. Inside a module the layers are controller (HTTP only), service (one method per use case, owns the transaction), domain (pure TypeScript: money, state machines, policies) and repository (explicit SQL through Kysely).

## 4. The money model

**Units.** Every amount is a `bigint` in minor units: IRT is stored in **rial** (the API speaks toman, ×10 at the edge), USDT in millionths. Both providers speak rial (PSP-01, PAY-01), so storing rial removes a conversion on every provider call. Amounts arrive and leave as strings. A lint rule rejects `parseFloat`, `Number(...)` and `toFixed`.

**Accounts.** Each user has three accounts per currency: `AVAILABLE` (what the user can spend), `FROZEN` (held by open withdrawals) and `DEBT` (owed after a late success, Ambiguity #1). System accounts: `PSP_CLEARING`, `PAYOUT_CLEARING`, `FEE_REVENUE`, `OPS_ADJUSTMENTS`. A CHECK constraint refuses a negative balance on every account that is not allowed one (only system accounts and DEBT are).

**Journals.** Every business event is one journal of two or more postings that sum to zero. A deferred constraint trigger checks the sum at commit, and triggers refuse any `UPDATE` or `DELETE` on journals and postings. A mistake is corrected by a new journal. `UNIQUE (kind, ref_type, ref_id)` makes booking the same event twice impossible, which is what makes every retry safe.

| Journal | Postings |
|---|---|
| `DEPOSIT_CREDIT` | PSP_CLEARING −v · user DEBT +min(debt, v) · user AVAILABLE +rest (v is the **verified** amount) |
| `ADJUSTMENT_CREDIT` | OPS_ADJUSTMENTS −x · user DEBT/AVAILABLE +x (debt first) |
| `TRANSFER` | sender AVAILABLE −x · receiver DEBT/AVAILABLE +x |
| `WITHDRAWAL_FREEZE` | user AVAILABLE −(amount + fee) · user FROZEN +(amount + fee) |
| `WITHDRAWAL_SETTLE` | user FROZEN −(amount + fee) · PAYOUT_CLEARING +amount · FEE_REVENUE +fee |
| `WITHDRAWAL_RELEASE` | user FROZEN −(amount + fee) · user AVAILABLE +(amount + fee) |
| `WITHDRAWAL_RETURN` | PAYOUT_CLEARING −amount · user DEBT/AVAILABLE +amount, debt first (the fee is kept) |
| `WITHDRAWAL_LATE_SUCCESS` | PAYOUT_CLEARING +x · user AVAILABLE −min(available, x) · user DEBT −rest |

A partial unique index allows a withdrawal to be settled **or** released, never both.

## 5. Flows

### Deposit (required)

1. `POST /deposits` with an `Idempotency-Key`. Transaction 1 claims the key with a 30-second lease and inserts the deposit as `CREATED`; it commits.
2. Outside any transaction, the PSP is asked to create a payment with `orderId = depositId` and `callbackUrl` pointing at our callback route.
3. Transaction 2 records the outcome: `PENDING` with the payment link (201), or `FAILED` if the PSP rejected it (also 201). If the PSP was unreachable, the lease is released and the client gets 503 `PROVIDER_UNAVAILABLE`; a retry with the same key resumes the same deposit.
4. The user pays on the PSP page. The PSP may call back, or may not (PSP-05).
5. A callback is stored in `inbound_events` and schedules a `deposit.sync` job. It never changes money: callbacks are unsigned, can say NOK for a paid payment, and can carry a forged amount (PSP-04 to PSP-07).
6. `deposit.sync` asks the PSP for the payment status. If it is `PAID`, it calls `verify`; on code 100 or 101 it credits the **verified** amount in one transaction with the status change to `SUCCEEDED`. A 503 from verify is retried within seconds; a `-51` while the payment is still INIT is not a failure (PSP-08, PSP-09).
7. If no callback arrives, the sweeper finds the deposit by `next_check_at` and runs the same sync: 15 s, 15 s, 30 s, then every minute for 30 minutes, then every 5 minutes. A deposit still unpaid after 24 hours becomes `FAILED (EXPIRED)`.

### Withdrawal (required)

1. `POST /withdrawals`. Before the transaction: validate the destination (Sheba mod-97 or TRC20 base58check, because the provider pays invalid addresses, PAY-06) and the minimum.
2. One transaction: claim the key; lock the user's accounts in id order; refuse if the user has debt or `available < amount + fee`; lock and reserve the daily-limit row; insert the `PENDING` withdrawal, the FREEZE journal and an outbox `withdrawal.submit` job; store the 201 on the key; commit.
3. The outbox relay publishes the job. The worker locks the row (`SKIP LOCKED`), moves it to `SUBMITTING` and records the attempt **before** the HTTP call, commits, then calls the payout service with `requestId = withdrawalId`.
4. The outcome is classified: 202 or a matching 200 replay → `PROCESSING`; 400 → resolved by a GET before failing; 503, timeout or reset → **ambiguous**, stays `SUBMITTING` and is resolved by a GET (PAY-03, PAY-04).
5. A webhook with a valid HMAC is stored and schedules a `withdrawal.sync`; the sync's own GET decides. `SUCCEEDED` books SETTLE; `FAILED` books RELEASE and gives back the daily-limit share; `RETURNED` after success books RETURN and keeps the status `SUCCEEDED` (PAY-07). Statuses only move forward, so a stale or duplicated webhook changes nothing (PAY-11).
6. After 30 minutes without a final answer the withdrawal is flagged `needs_review = STUCK`. It is never failed on silence; the money stays frozen.
7. A `SUCCEEDED` withdrawal is watched for a bank return for 24 hours.

### Other flows

- **Cancel** (`POST /withdrawals/{id}/cancel`): only while `PENDING`; see `ambiguities.md`.
- **Transfer** (bonus): one transaction, both users' accounts locked in global id order, so opposite transfers never deadlock.
- **Adjustment**: an `ADJUSTMENT_CREDIT` journal with a mandatory reason and an optional operator id.
- **Balance events** (bonus): every journal writes one `wallet.balance.changed` outbox row per affected user, in its own transaction. The notification consumer records the event and an inbox row in one transaction, so a duplicate delivery is applied once.
- **Reconciliation** (bonus): downloads the PSP settlement CSV, normalises Persian digits and padded references, matches by bank reference, stores and returns every mismatch. It never changes money.

## 6. How each guarantee is enforced and proved

| Guarantee from the brief | Mechanism | Proof |
|---|---|---|
| 100 concurrent withdrawals on one balance across instances: never negative, daily limit holds | PostgreSQL row locks in a fixed order inside one transaction; `CHECK balance ≥ 0`; `CHECK used ≤ cap` | `withdrawal-concurrency.int.spec.ts`: 100 requests split across two app instances, exact success counts for funds and for the limit |
| Same Idempotency-Key, sequential or concurrent, has one effect | The key is inserted in the business transaction; a twin blocks on the primary key and then replays the stored response | Same suite, same key ×100; `idempotency.int.spec.ts` |
| No floats | `bigint` everywhere; amounts as strings; lint rule | `money.spec.ts`, `amount.spec.ts`, ESLint |
| A balance event survives a crash right after commit and is applied once (bonus) | Transactional outbox; at-least-once relay; inbox table keyed by (consumer, message id) | `balance-events.e2e.int.spec.ts`, `outbox-relay.int.spec.ts`, `notification.int.spec.ts` |
| A crash at any step of a withdrawal leaves nothing unknown and pays nothing twice | Attempt recorded before the call; one `requestId` per withdrawal, never regenerated; ambiguous outcomes resolved by GET; sweeper picks up anything left | `withdrawal-chaos.int.spec.ts` (three crash points and random faults), `tools/hardening/chaos.mjs` |
| Critical data survives the loss of any component except the database | No Redis; the broker holds only ids; retry times live in `next_check_at` | `broker-restart.int.spec.ts`, chaos scenario D (RabbitMQ killed twice under load) |
| A paid deposit is always credited, never more than paid | Pull-to-decide; verified amount only; poller; `UNIQUE psp_ref_id` | `deposit-sync.handler.int.spec.ts`, `deposit-lifecycle.int.spec.ts`, smoke run against the real simulator |

At the time of writing the suite has 40 unit spec files, 42 integration spec files against real PostgreSQL and RabbitMQ, and one end-to-end suite against the full compose stack: 1,372 tests in total.

## 7. Why this stack

| Choice | Reason | Cost I accept |
|---|---|---|
| NestJS 11 on Node 22 (CommonJS) | Required by the brief. Version 11 is the mature line; 12 had shipped two months earlier as ESM-only with new default tooling, which was a risk inside a four-day window | One major version behind |
| PostgreSQL 17 | Required. Row locks, CHECK constraints, deferred constraint triggers and partial indexes carry most of the correctness | One primary is the write bottleneck at very high scale (see `scalability.md`) |
| TypeORM for the DataSource and migrations, Kysely as a typed query builder | Versioned migrations from the Nest standard; SQL on money paths stays explicit and visible, with `FOR UPDATE` where I need it, and table and column names are type-checked against the migrated schema | Two libraries; generated types must be refreshed after each migration |
| RabbitMQ 4 with quorum queues | Durable replicated queues, competing consumers, a delivery limit with a dead-letter queue, publisher confirms, and a UI for the demo | One more container, and delivery is at least once, so every consumer is idempotent |
| No Redis | Nothing needs it. Locks in Redis are the failure in the brief's incident; keeping coordination inside the database removes that class of bug | Hot rows serialise on PostgreSQL row locks |
| nginx in front of two API replicas | Proves the design works with several instances on every request, not only in tests | None of note |
| Jest with real databases in integration tests | Constraints and triggers are part of what is tested; mocking the database would hide them | Integration tests are slower and share one test database |

## 8. Known limitations and risks

These are the points I would raise myself in a review.

1. **Status events are declared but not produced.** `deposit.status.changed` and `withdrawal.status.changed` are bound to the `notify.events` queue, but only `wallet.balance.changed` is emitted. The brief asks for notification after every balance change, which is met. Adding status events means one `outbox.add` beside each compare-and-set status update, in the same transaction.
2. **The invariant check alerts only through the log.** The workers run it every 5 minutes (`INVARIANTS_CHECK_INTERVAL_MINUTES`) and log an `ALERT` on any violation. There is no metrics endpoint yet, so the alert depends on someone watching the logs. Each run scans all postings, which at large scale would move to a read replica or an incremental check.
3. **The review queue has no API.** Records flagged `needs_review` (STUCK, LATE_SUCCESS, REPLAY_MISMATCH, UNVERIFIED_TOO_LONG, DUPLICATE_REF and others) are visible in `GET /withdrawals/{id}` and `GET /deposits/{id}`, and alerts are logged, but listing and resolving them is done in the database.
4. **Debt is per currency.** A user with IRT debt cannot withdraw IRT but can still withdraw USDT. Collecting across currencies is a business decision I did not make on my own.
5. **The USDT daily-limit rate is configured, not live** (Ambiguity #2). It is snapshotted per withdrawal, so accounting stays correct when it changes.
6. **No end-user authentication.** The brief says users need no registration, so any caller can act on any `userId`. In production an API gateway would bind `userId` to the caller's token. `/internal/*` is protected by `INTERNAL_API_KEY` when it is set; the compose default leaves it empty and publishes nginx on 127.0.0.1 only.
7. **Hot rows.** A single very busy wallet serialises on its row lock, and every adjustment writes the one `OPS_ADJUSTMENTS` row. Both are measured in `scalability.md`.
8. **An audit table for status changes was designed but not built.** The earlier design listed a `state_transitions` table and a restricted database role. Neither was implemented; the history of a withdrawal is reconstructed from its journals, `payout_attempts`, `inbound_events` and its timestamp columns. Journals and postings are protected by triggers regardless of the role.
9. **Late payment after deposit expiry** relies on the gateway reversing an unverified payment (observed in the simulator, PSP-10). A real gateway that does not reverse would need a manual refund; such deposits are flagged `LATE_PAYMENT_AFTER_EXPIRY`.
10. **The integration suites share one test database** and leave committed rows. Several suites take advisory locks or backdate their own rows so leftover data cannot affect them. A fresh database per run would be simpler and is the first thing I would change in CI.

## 9. Where to read more

| Document | Contents |
|---|---|
| `design.md` | The two-page design, written before the code, with its changelog |
| `modules.md` | Each module's services, operations and process roles |
| `data-model.md` | Every table, key, constraint and index |
| `state-machines.md` | Every deposit and withdrawal transition, and what a restart finds after a crash |
| `adr/` | 13 decision records |
| `provider-notes.md`, `evidence/` | Simulator behaviour I observed and how it changed the design, with request and response excerpts |
| `ambiguities.md` | The three deliberate ambiguities |
| `incident-analysis.md` | The negative-balance incident |
| `scalability.md` | First bottleneck at 50× load, with measurements |
| `running.md` | How to run the stack, the tests, the simulator modes and the hardening tools |
| `api/openapi.json` | The API contract |
