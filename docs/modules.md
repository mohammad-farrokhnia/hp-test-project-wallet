# Modules and services

One NestJS 11 codebase, split into modules that each own their tables and expose one service. It runs in two roles from the same image: `api` serves HTTP, `worker` runs consumers, the outbox relay and the sweeper. This file specifies each module's operations, inputs, outputs and failure modes. Tables are in `data-model.md`; lifecycles in `state-machines.md`.

## Module map

Modules sit in layers. A module may call anything below it, never above.

```
 HTTP edge (api)       wallet   operations   withdrawal   deposit   transfer
 Background (worker)   scheduler   messaging relay and consumers
        |
 Core services         ledger   idempotency   messaging (outbox)
 Integrations          PspClient   PayoutClient   WebhookVerifier   InboundEvents
        |
 Foundation            common   database   config
```

Who calls whom:

| Module | Calls |
|---|---|
| wallet | ledger |
| operations | ledger, idempotency, withdrawal (open totals for the invariant check) |
| withdrawal | ledger, idempotency, messaging, PayoutClient, WebhookVerifier, InboundEvents |
| deposit | ledger, idempotency, messaging, PspClient, InboundEvents |
| transfer | ledger, idempotency |
| notification | ledger (reads balances), messaging (inbox) |
| ledger | messaging (the outbox, for balance events) |
| scheduler | withdrawal and deposit, only through the `DueWorkSource` interface they implement |
| messaging relay | delivers jobs to handlers in withdrawal and deposit |
| core services and integrations | foundation |

Nothing points back: the ledger knows nothing about withdrawals, and the scheduler only knows an interface that withdrawal and deposit implement.

## Global rules

1. **One transaction per state change.** A service opens it with `TransactionRunner.run(fn)` and passes `tx` down explicitly. Inside it: `lock_timeout = 3 s`, `statement_timeout = 5 s`. A deadlock (40P01) or serialization failure (40001) retries the whole function up to 3 times.
2. **No network call inside a transaction.** Provider calls happen between two short transactions.
3. **Lock order**, used everywhere so deadlocks can't form: idempotency key → the deposit or withdrawal row → accounts in ascending id → the daily-usage row.
4. **Modules don't touch each other's tables.** They call the exported service. An ESLint `no-restricted-imports` rule blocks imports of another module's `repositories/` or `domain/`.
5. **Inbound pushes never change money.** Callbacks and webhooks are recorded and schedule a sync; only a sync (our own GET or verify) changes state (ADR-3).
6. **Statuses change only through the module's state machine**, using compare-and-set: `UPDATE … WHERE id = $1 AND status = $expected`. Zero rows updated means someone else already moved it, and the handler stops.

## Process roles

| Role | Loads | Replicas |
|---|---|---|
| `api` | all controllers, guards, filters; publishes nothing directly (writes outbox rows) | 2, behind nginx `app:3000` |
| `worker` | outbox relay, job consumers, sweeper, cleanup, invariant checker; no controllers except `/health` on an internal port | 2 |
| `all` | both (local development) | 1 |

## Foundation

| Unit | Responsibility | Key operations |
|---|---|---|
| `config` | Reads and validates every env variable at boot; typed access | `AppConfig` (business limits, timeouts, URLs, role) |
| `common/money` | `Money` value object and currency registry (`IRR` scale 0 with API code `IRT` ×10, `USDT` scale 6) | `parseApiAmount(currency, string)`, `formatApiAmount(money)`, `toProviderAmount(money)`, arithmetic on `bigint` only |
| `common/errors` | Error catalog, `AppError`, global exception filter, constraint-error mapper | Every error leaves as `{code, message}` |
| `common/validation` | DTO validation pipe; destination validators | `normalizeIban`, `isValidIban` (mod-97), `isValidTrc20` (base58check, prefix 0x41) |
| `common/guards` | `InternalApiKeyGuard` via `@InternalOnly()`: active only when `INTERNAL_API_KEY` is set; then `X-Internal-Api-Key` must match (sha256 + constant-time compare), else 401 `UNAUTHORIZED`. Runs before the Idempotency-Key check. Warns at boot (api role) when off. A test fails if any `/internal` or `/reconciliation` controller lacks it | `/internal/*`, `/reconciliation/run` |
| `common/time` | Business clock from the database | `tehranDay(tx, at?)` → `'YYYY-MM-DD'` from the database `now()` (or `at`, for tests); DATE columns are read as text everywhere (`data-source.ts`) so a day never shifts by a timezone |
| `database` | DataSource, migration runner, transaction runner | `TransactionRunner.run(fn, {retries})` |
| `health` | Liveness and readiness | `/health`, `/ready` (database + RabbitMQ) |

## Core modules

### ledger
**Owns:** `accounts`, `journals`, `postings`. **Depends on:** messaging (the outbox, for balance events). **Used by:** every money flow.

| Operation | Input → output | Transaction | Notes / errors |
|---|---|---|---|
| `ensureUserAccounts(tx, userId, currency)` | → account ids for AVAILABLE, FROZEN, DEBT | caller's | `INSERT … ON CONFLICT DO NOTHING`, then select; safe under concurrency |
| `lockUserAccounts(tx, userId, currency)` | → locked balances `{available, frozen, debt}` | caller's | `SELECT … FOR UPDATE` in id order; used for pre-checks |
| `lockUsersAccounts(tx, userIds, currency)` | → each user's ids and locked balances | caller's | For operations between users (transfers). Creates the accounts in sorted user order, then locks **all** of them in ONE ascending-id statement, so A→B and B→A can never deadlock (ADR-1) |
| `post(tx, journal)` | `{kind, refId, currency, description?, reversesJournalId?, lines[{accountId, amount: Money}]}` → `{journalId, alreadyBooked}` | caller's | Validates first (≥ 2 non-zero lines, one currency, no account twice, sum 0); locks the accounts in id order (already-held rows don't wait); inserts the journal, whose `refType` follows from `kind`; computes `balance_after` per line and refuses a protected balance below zero or DEBT above zero; inserts the postings; updates the balances. A duplicate `(kind, ref)` writes nothing and returns the existing journal with `alreadyBooked = true`, so callers stay idempotent. Accounts are locked before the journal insert so a duplicate waits on the account lock instead of holding one. Failures are `LedgerError` (`INVALID_JOURNAL`, `ACCOUNT_NOT_FOUND`, `INSUFFICIENT_BALANCE`): caller bugs, so 500 at the edge |
| `systemAccountId(tx, kind, currency)` | → account id | caller's | The seeded `PSP_CLEARING`, `PAYOUT_CLEARING`, `FEE_REVENUE` or `OPS_ADJUSTMENTS` account |
| `creditLines({availableId, debtId, debt}, amount)` (domain, pure) | → posting lines | — | The only way money reaches a user: DEBT first, the rest to AVAILABLE. Used by `creditUser`, and inside transfer journals |
| `creditUser(tx, {userId, amount, source, kind, refId, description?})` | → `{journalId, alreadyBooked}` | caller's | One journal of `source −amount` + `creditLines`; locks AVAILABLE, DEBT and the source in id order before reading the debt |
| `getBalances(tx, userId)` | → per currency `{available, frozen, debt}` | caller's (read) | No locks, no writes; unknown user returns zeros in every currency |
| `listHistory(tx, userId, {beforeId?, limit})` | → postings with journal kind, ref, description; `nextBeforeId` | caller's (read) | Keyset `id < beforeId ORDER BY id DESC LIMIT limit + 1` on `postings (user_id, id DESC)`, journals joined by PK |
| `checkLedger(tx)` | → one result per invariant `{name, ok, violations[], truncated}` | caller's (read) | `ZERO_SUM`: every journal sums to 0, has ≥ 2 postings, one currency · `BALANCE_EQUALS_POSTINGS`: balance = Σ postings and = the latest `balance_after` · `NO_NEGATIVE_BALANCES`: no protected balance below 0, no DEBT above 0 · `AVAILABLE_ONLY_WITHOUT_DEBT`. Lists the first 100 violations per check |
| `frozenBalances(tx)` | → non-zero FROZEN balances per user and currency | caller's (read) | Input to the operations FROZEN check |

### idempotency
**Owns:** `idempotency_keys`. **Depends on:** nothing but foundation.

| Operation | Input → output | Transaction | Notes / errors |
|---|---|---|---|
| `claim(tx, {key, scope, body})` | → `NEW` \| `REPLAY {status, body}` | caller's, before any other lock | `INSERT … ON CONFLICT DO NOTHING`. A concurrent twin blocks until the first commits, then replays (or gets `NEW` if the first rolled back). Fingerprint = sha256(scope + canonical JSON body, keys sorted). Different fingerprint, including the same key on another route → `IDEMPOTENCY_KEY_REUSED` (422). Wait exceeds `lock_timeout` → `IDEMPOTENCY_IN_PROGRESS` (409) |
| `complete(tx, key, {status, body}, resource?)` | → void | caller's | Stores the exact response to replay (as `json`, so byte for byte); key must be `IN_PROGRESS` |
| `claimWithLease(tx, {key, scope, body}, seconds)` | → `NEW` \| `REPLAY` \| `IN_PROGRESS` \| `RESUME {resource}` | caller's: the same transaction inserts the deposit and calls `attachResource`, then commits before the PSP call | Two-phase deposit create only. Lease = `locked_until` on the database clock. A twin inside the lease gets `IN_PROGRESS`; once the lease is released or expired (the earlier attempt died), a retry gets `RESUME` with the record and a new lease |
| `attachResource(tx, key, {type, id})` | → void | caller's | Records what a leased request created, so `RESUME` can return it |
| `releaseLease(tx, key)` | → void | caller's | After an ambiguous provider failure, so a retry can resume at once |
| `IdempotencyCleanupJob.purgeOlderThan(days)` | → count | own, one per batch of 1,000 | Worker role, every `IDEMPOTENCY_CLEANUP_INTERVAL_MINUTES` (60) with `IDEMPOTENCY_RETENTION_DAYS` (7). `FOR UPDATE SKIP LOCKED`: skips keys a request holds and lets every worker run it at once |

What gets stored: 2xx responses and state-dependent 422s (`INSUFFICIENT_FUNDS`, `DAILY_LIMIT_EXCEEDED`). Not stored: 400s and pre-transaction 422s like `BELOW_MINIMUM` (recomputed identically), and 5xx (the transaction rolled back).

**HTTP edge (I2).** Every financial POST is declared with `@FinancialPost(path)` instead of `@Post`: its guard refuses a missing or empty `Idempotency-Key` with `IDEMPOTENCY_KEY_REQUIRED` (400) and a malformed one (not 1–255 printable ASCII) with `VALIDATION_ERROR` (400), before body validation. `@IdempotencyKey()` hands the checked key to the handler; `sendIdempotent(res, response, replayed)` sets the stored status and `Idempotent-Replayed: true` on a replay. Webhooks and reconciliation are marked `@IdempotencyExempt(reason)`. A test audits every POST route in every role and fails if one is neither.

### messaging
**Owns:** `outbox`, `inbox`. **Depends on:** RabbitMQ.

| Unit | Responsibility |
|---|---|
| `OutboxService.add(tx, {exchange, routingKey, aggregate, payload})` | Writes a message in the caller's transaction (exported, every role); returns the outbox id, which is the message id. Payload is ids only (string values) |
| `OutboxRelay` (worker) | One round: claim up to `OUTBOX_RELAY_BATCH_SIZE` (100) unsent rows in a short transaction (`FOR UPDATE SKIP LOCKED`, `claimed_until = now + OUTBOX_CLAIM_SECONDS` (30), `attempts + 1`), publish each with confirms **outside** any transaction, then mark `published_at` (and record failures) in a second short transaction. Runs again at once after a full batch, else after `OUTBOX_RELAY_INTERVAL_MS` (500). **Never twice:** a publish only starts if, at its worst case (`RabbitPublisher.maxPublishMs`), it ends before the claim does; the rest stay claimed for later, and boot fails if the claim is too short for that. **Never lost:** a relay that dies before marking leaves its rows claimed; after expiry another relay republishes them (consumers drop the duplicate by message id). A failed publish keeps `last_error` and backs off (`claim × 2^(attempts−1)`, at most 10 min) |
| `RabbitTopology` (`topology.ts`) | The layout below as data; `declareTopology` runs on every (re)connect. Same arguments are a no-op; changed arguments fail with PRECONDITION_FAILED instead of silently keeping the old queue |
| `RabbitConnection` (worker) | One amqplib recovering connection: boot never waits for the broker, reconnects with backoff (200 ms to 30 s), redeclares the topology after each connect, reopens the confirm channel after it closes. Host and port from `RABBITMQ_HOST`/`RABBITMQ_PORT` |
| `RabbitPublisher` (worker) | Publisher confirms: resolves only on the broker's ack. Persistent, `mandatory`, `messageId`. A nack, no confirm within `RABBITMQ_PUBLISH_TIMEOUT_MS` (5 s) or a lost channel is retried `RABBITMQ_PUBLISH_RETRIES` (3) times with the same message id; an unroutable message fails at once (`UNROUTABLE`) |
| `JobConsumer` (worker; one per `JobHandler`, listed in `JobsModule.register`) | Prefetch `JOB_PREFETCH` (10); parses the envelope; calls `handler.handle(envelope, {attempt})`; **acks only after it returns, i.e. after the handler's transaction committed**. RabbitMQ 4 does not count a `nack` with requeue toward the delivery limit (measured in M2), so attempts are counted in an `x-attempt` header: on a throw below `JOB_MAX_ATTEMPTS` (5) it waits `JOB_RETRY_BACKOFF_MS × attempt`, republishes a copy with `x-attempt + 1` (confirmed, same message id) and acks the original; at the limit it nacks without requeue, so the broker dead-letters it to `job.dead`. A body that is not an envelope goes to `job.dead` at once. A worker that dies mid-job never acked: the job comes back, and those lost deliveries count toward the queue's own limit (5), so that path also ends in `job.dead`. Re-subscribes whenever its channel closes (reconnect, broker cancel). `stop()` waits up to 10 s for jobs in progress; anything still running is redelivered. The row's `next_check_at` makes the sweeper retry later regardless |
| `InboxService.markProcessed(tx, consumer, messageId)` | Consumer-side de-duplication: inserts `(consumer, message_id)` in the consumer's own transaction; returns false if this consumer already handled the message. A rolled-back effect leaves no row, so its retry runs again |
| `MessagingRetentionJob` (worker) | Every `RETENTION_INTERVAL_MINUTES` (60): deletes outbox rows **published** more than `OUTBOX_RETENTION_DAYS` (3) ago and inbox rows older than `INBOX_RETENTION_DAYS` (7), in batches of 1,000 with `SKIP LOCKED`. An unsent outbox row is never deleted |

**Topology.**

| Exchange | Type | Routing key → queue | Consumer |
|---|---|---|---|
| `wallet.jobs` | direct | `job.withdrawal.submit` → quorum queue of the same name | `WithdrawalSubmitHandler` |
| | | `job.withdrawal.sync` → `job.withdrawal.sync` | `WithdrawalSyncHandler` |
| | | `job.deposit.sync` → `job.deposit.sync` | `DepositSyncHandler` |
| `wallet.dlx` | fanout | → `job.dead` | none (alert + manual) |
| `wallet.events` | topic | `wallet.balance.changed`, `deposit.status.changed`, `withdrawal.status.changed` → quorum queue `notify.events` (same delivery limit and DLX as the job queues) | `NotificationHandler` (inbox de-dup). Only `wallet.balance.changed` is emitted so far |

**Envelope:** `{messageId, type, aggregateType, aggregateId, occurredAt, payload}`; `messageId` is the outbox id, `type` the routing key, `payload` the row's ids. Ids only: handlers always reload state from the database, so a stale or duplicated message can't move money.

## Business modules

### wallet
**Owns:** nothing. **Depends on:** ledger.

| Endpoint | Operation | Output |
|---|---|---|
| `GET /wallets/:userId` | `WalletService.getWallet(userId)` → `ledger.getBalances`, in a read-only transaction | `200 {userId, balances: [{currency: "IRT" \| "USDT", available, frozen, total, debt}]}`; both currencies always listed; total = available + frozen; `debt` is the amount owed, zero or positive (stored as ≤ 0 on DEBT); an unknown user gets zeros and no row is created; a malformed userId gives 400 `VALIDATION_ERROR` |
| `GET /wallets/:userId/ledger?limit&cursor` | `WalletService.getHistory` → `ledger.listHistory` | `200 {items: [{id, journalId, type, bucket, currency, amount, balanceAfter, reference: {type, id}, description, createdAt}], nextCursor}`; limit 1–100, default 20; cursor is opaque base64url of the last posting id, accepted only in exactly the form we issue; a bad cursor gives 400 `INVALID_CURSOR`; a bad or unknown query parameter gives 400 `VALIDATION_ERROR`. `amount` is signed (negative = money left the bucket); `bucket` is AVAILABLE, FROZEN or DEBT; `type` is the journal kind. Keyset, so page 1,000 costs what page 1 does (`npm run test:perf`: 1M postings, page 1,000 under 50 ms) |

### operations
**Owns:** `adjustments` (+ `reconciliation_*`, bonus). **Depends on:** ledger, idempotency, withdrawal (open totals for the invariant check), psp (bonus).

| Endpoint | Operation | Transaction | Notes |
|---|---|---|---|
| `POST /internal/adjustments` | `AdjustmentsService.create({userId, currency, amount, reason, actor}, key)` | one: claim → `ledger.creditUser` (ADJUSTMENT_CREDIT from OPS_ADJUSTMENTS, DEBT first; creates accounts on first use) → insert adjustment (it references the journal) → complete | `201 {adjustmentId, journalId, userId, currency, amount}`; `adjustmentId` is UUIDv7, `journalId` a string; guard; `@FinancialPost`; `reason` 3–500 chars; `amount` > 0 (IRT whole toman, stored as rial); `X-Operator-Id` optional, 1–128 printable ASCII, stored as `actor` |
| `GET /internal/invariants` | `InvariantsService.check()` = `ledger.checkLedger()` + `FROZEN_EQUALS_OPEN_WITHDRAWALS` (FROZEN equals `openTotals()` per user and currency) | own: read-only, REPEATABLE READ, so every check sees one snapshot | `200 {ok, checkedAt, checks: [{name, ok, violations, truncated}]}`, also when `ok` is false. For the live demo and alerts. Lives here, not in ledger, so the ledger never depends on withdrawal. Open totals come through the `OpenWithdrawalTotals` port, which withdrawal implements (X3); until then nothing may be frozen |
| `GET /internal/reviews` | lists deposits and withdrawals with `needs_review` | read | Optional ops view |
| `POST /reconciliation/run` (bonus) | `ReconciliationService.run(date)` | own | Fetch CSV, match by refId, store run + mismatches, change no money; no Idempotency-Key |

### withdrawal
**Owns:** `withdrawals`, `payout_attempts`, `withdrawal_daily_usage`. **Depends on:** ledger, idempotency, messaging, payout, inbound events.

| Unit | Responsibility |
|---|---|
| `WithdrawalController` | `POST /withdrawals`, `GET /withdrawals/:id`, `POST /withdrawals/:id/cancel` (bonus) |
| `PayoutWebhookController` | `POST /webhooks/payout`: raw-body HMAC, record, schedule sync, 200 |
| `WithdrawalService` | `request`, `get`, `cancel`, `openTotals()` (Σ amount + fee of non-final withdrawals per user and currency) |
| `WithdrawalPolicy` (domain) | `buildPolicies(config.limits)`: per currency the minimum, fee, destination type and the rial counted toward the daily limit. IRR: 100,000 toman, no fee, IBAN, counted in full. USDT: 10 USDT, 1 USDT fee, TRC20, counted toward the toman cap at `USDT_IRT_REFERENCE_RATE` (toman per USDT, default 100,000), rounded up, fee not counted (ADR-12). `quoteWithdrawal(policy, amount)` → `{amount, fee, total = amount + fee, limitAmountRial, limitRateRialPerUsdt}` (the rate is saved on the withdrawal row), or `BELOW_MINIMUM`, or `TOO_LARGE` when amount + fee cannot be held (400) |
| `WithdrawalStateMachine` (domain) | The transition table in `state-machines.md`; `next(status, event)` |
| `WithdrawalOutcomeService` | Applies a provider snapshot: journals, status, flags, `next_check_at`, transition row, events |
| `DailyLimitRepository` | `reserve(tx, {userId, day, amountRial, capRial})` → bool: creates the day's row with today's cap, then one `UPDATE … SET used = used + x WHERE used + x <= cap`, so concurrent requests can't both pass. `release` gives an amount back to its day (never below zero). Locked last (ADR-1) |
| `WithdrawalSubmitHandler` | Consumer of `job.withdrawal.submit` |
| `WithdrawalSyncHandler` | Consumer of `job.withdrawal.sync` |
| `WithdrawalDueWork` | Implements the scheduler's `DueWorkSource` |

**Body:** `{userId, currency: "IRT" | "USDT", amount, destination}`; the destination type follows from the currency (IRT → Sheba IBAN, spaces/lowercase accepted and normalised; USDT → TRC20).

**`request(cmd, key)`**, one transaction (ADR-1). Before the transaction: DTO validation (400), destination validation (400 `INVALID_DESTINATION`), minimum (422 `BELOW_MINIMUM`). Then:
1. `idempotency.claim` (replay → return the stored response).
2. `ledger.ensureUserAccounts` + `lockUserAccounts`.
3. `available < amount + fee` → stored 422 `INSUFFICIENT_FUNDS`.
4. `DailyLimitRepository.reserve(tx, userId, tehranDay, limitAmount)` (creates and locks the row) → over the cap: stored 422 `DAILY_LIMIT_EXCEEDED`.
5. Insert the withdrawal (`PENDING`, `next_check_at = now + WITHDRAWAL_SAFETY_NET_SECONDS` (30 s) as a safety net), `ledger.post(WITHDRAWAL_FREEZE)` (amount + fee, AVAILABLE → FROZEN), `outbox.add(job.withdrawal.submit)`. *(The transition row waits for a `state_transitions` migration, which no task has created yet.)*
6. `idempotency.complete(201 {withdrawalId, status: "PENDING"})`, then commit.

**`get(id)`:** `200 {withdrawalId, status, userId, currency, amount, fee, destination (masked: first and last 4 characters), failureReason, returnedAt, returnReason, needsReview, createdAt, updatedAt}`; unknown or malformed id → 404 `NOT_FOUND`.

**Wiring:** `WithdrawalModule` (service, repositories, policies; every role) and `WithdrawalApiModule` (controller; api role only). `WithdrawalService.openTotals` is bound as operations' `OpenWithdrawalTotals`, so `/internal/invariants` compares FROZEN with real open withdrawals.

**`WithdrawalSubmitHandler`:**
1. Transaction 1: lock the withdrawal row (`FOR UPDATE SKIP LOCKED`; locked means another worker has it, so ack and stop). Continue only if `PENDING`, or `SUBMITTING` with no in-flight attempt (an unfinished attempt younger than `WITHDRAWAL_SUBMIT_LEASE_SECONDS`, 30 s; older ones belong to a dead process) **and** the job is W5's resubmit (payload `after: NOT_FOUND`, queued only after a GET found nothing). A duplicate or stray submit job for a SUBMITTING withdrawal does nothing: we always ask before resubmitting (the crash table), even though the provider would de-duplicate (PAY-02). Move to `SUBMITTING`, open attempt n with the exact request body, set `next_check_at = now + lease`. Commit. Boot fails if the lease does not outlast `HTTP_TIMEOUT_MS`.
2. `PayoutClient.submit` (10 s timeout).
3. Transaction 2: close the attempt with its outcome, then by outcome:
   - `ACCEPTED`, or `REPLAYED` with matching fields → `PROCESSING`.
   - `REPLAYED` with different fields → stays `SUBMITTING`, `needs_review = REPLAY_MISMATCH`.
   - `REJECTED` → schedule an immediate sync. FAILED only after a GET confirms 404.
   - `AMBIGUOUS` → stays `SUBMITTING`, `next_check_at` by backoff.

**`WithdrawalSyncHandler`** (`domain/withdrawal-state-machine.ts` holds the W5–W11 decisions as a pure function; the handler applies them with compare-and-set under the row lock; journals: SETTLE = FROZEN −(x+fee), PAYOUT_CLEARING +x, FEE_REVENUE +fee; RELEASE = FROZEN → AVAILABLE; RETURN through `ledger.creditUser` from PAYOUT_CLEARING, so it pays DEBT first like every credit). Return watch: `WITHDRAWAL_RETURN_WATCH_HOURS` (24); past it, a sync without a webhook stops checking (W15). `WithdrawalDueWork` is the sweeper's source (bump first; submit while PENDING, else sync):
1. Read the row. A non-final status, `SUCCEEDED` within the return window, or any status when a signed webhook triggered the job (that is how W12 is found) needs a GET; anything else acks and stops.
2. `PayoutClient.getTransfer`:
   - a snapshot goes to `WithdrawalOutcomeService.apply`;
   - `NOT_FOUND` while `SUBMITTING` with no in-flight attempt → enqueue submit with the same requestId;
   - `NOT_FOUND` after the provider had accepted it → `needs_review`;
   - unavailable → reschedule.

**W12 (Ambiguity #1, ADR-10):** a sync that finds a FAILED withdrawal SUCCEEDED (pulled because a signed webhook asked) books `WITHDRAWAL_LATE_SUCCESS` from the locked balances with `ledger.clawbackLines` (PAYOUT_CLEARING +x, AVAILABLE −min(available, x), DEBT −rest), sets SUCCEEDED, `late_success_at`, clears `failure_reason`, keeps `completed_at`, flags `LATE_SUCCESS` and logs an `ALERT`; the daily limit is not reserved again. RETURNED instead: the claw-back and the return together. While a currency's DEBT is below zero, `POST /withdrawals` in it answers a stored 422 `INSUFFICIENT_FUNDS` ("Outstanding debt must be repaid before withdrawing").

**Crash and chaos (X11):** `withdrawal-chaos.int.spec.ts` drives the real handlers, sweeper source and outbox against `FakePayoutServer` (stateful, de-duplicating, failing per finding) with crashes at the three crash points; it asserts one transfer per requestId, every withdrawal final and agreeing with the provider, one terminal journal each, nothing left frozen.

**`PayoutWebhookController`:**
1. Verify `x-signature` = hex HMAC-SHA256(raw body, secret) in constant time. Invalid → `inbound_events` (`REJECTED_SIGNATURE`) and 401.
2. Valid → in one transaction: record it; look up the withdrawal by `requestId`. Unknown (or not a uuid) → `UNKNOWN_REFERENCE`, 200. Known → `next_check_at = now()` plus outbox `job.withdrawal.sync` with `trigger: WEBHOOK` (so the sync pulls even a final withdrawal), 200 `{received: true}`. The status in the body is never applied. Target: under 50 ms.

The verifier compares the decoded digests with `timingSafeEqual` after checking for exactly 64 hex characters; it is tested against signatures captured from the simulator. A body that is not JSON is not refused by the body parser: it is read as raw bytes, so the delivery is recorded as received and answered like any other (401 without a valid signature, otherwise 200).

### deposit
**Owns:** `deposits`. **Depends on:** ledger, idempotency, messaging, psp, inbound events.

| Unit | Responsibility |
|---|---|
| `DepositController` | `POST /deposits`, `GET /deposits/:id` |
| `PspCallbackController` | `POST /webhooks/psp/callback/:depositId` (the `callbackUrl` we give the PSP carries our id) |
| `DepositService` | `create`, `get` |
| `DepositStateMachine` (domain) | Transition table |
| `DepositSyncHandler` | Consumer of `job.deposit.sync` |
| `DepositDueWork` | `DueWorkSource`: `PENDING` deposits whose `next_check_at` is due become `job.deposit.sync` (the poller behind lost callbacks) |
| `DepositWatchdog` | `DueWorkSource` that queues nothing: fails abandoned creates, flags and alerts on payments seen paid but unverified for 2 minutes |

**`create(cmd, key)`**, two-phase (ADR-8). Before anything: DTO validation, then minimum 1,000 toman (422 `BELOW_MINIMUM`). Then `idempotency.claimWithLease(30 s)`:
- `REPLAY` → stored response.
- `IN_PROGRESS` → 409.
- `RESUME` → continue with the existing deposit.
- `NEW` → insert the deposit `CREATED`, `expires_at = now + 24 h`. Commit.

Next, `PspClient.createPayment(amountRial, orderId = depositId, callbackUrl)`. Then, in transaction 2:

| PSP result | What happens | Response |
|---|---|---|
| 201 | `PENDING` with token and URL, `psp_status = INIT`, `next_check_at = now + 15 s`; key completed | 201 `{depositId, status: "PENDING", paymentUrl}` |
| 4xx | `FAILED` (`PSP_REJECTED`); key completed | 201 `{depositId, status: "FAILED", paymentUrl: null}` |
| timeout / 5xx | Stays `CREATED`; lease released | 503 `PROVIDER_UNAVAILABLE`, not stored; a retry with the same key resumes the same deposit |

**`PspCallbackController`:**
1. Record in `inbound_events`.
2. Load the deposit by the path id. The body's `orderId` must equal it, and its `token` must equal ours once known; otherwise `MISMATCH`.
3. Non-final deposit → `next_check_at = now()` plus outbox `job.deposit.sync`.
4. Always answer 200. The callback's `status` and `amount` are ignored (PSP-06/07). The body is read as raw bytes whatever its content type (`common/http`: webhook routes skip the JSON parser), so a body that is not valid JSON is recorded exactly as received and still answered 200, or 401 for a payout webhook without a valid signature. Only a body over the 100 KB limit is refused by the parser (400) before our code runs.

**`DepositSyncHandler`:**
1. `PspClient.getPayment(token)`.
2. By the PSP status:
   - `INIT` → reschedule on the poll schedule; once `expires_at` has passed → `FAILED (EXPIRED)`. Only INIT expires: a payment that is already PAID is verified and credited, and the PSP not answering never expires anything.
   - `PAID` or `VERIFIED` → `verify`. On `OK` (100) or `ALREADY_VERIFIED` (101), in one transaction: lock the deposit (compare-and-set PENDING → SUCCEEDED), `ledger.creditUser(DEPOSIT_CREDIT, verified amount)`, set `psp_ref_id` and `credited_rial`, transition row; `needs_review = AMOUNT_DIFFERS` if the verified amount ≠ requested. `UNAVAILABLE` (503) → retry in 5 s. `NOT_PAID` (−51) → re-read the status next round.
   - `FAILED` → `FAILED (PSP_FAILED)`.
   - `REVERSED` → `FAILED (PSP_REVERSED)`.

   The lookup and `verify` run outside any transaction; the decision is made on the row as locked. A bank reference that already credited another deposit violates `UNIQUE (psp_ref_id)`: that update is refused, the deposit is flagged `DUPLICATE_REF` with an alert and checked hourly, and the job ends normally, so money is never booked twice and no poison job loops. A deposit that is not `PENDING` costs no PSP call.

### transfer
**Owns:** `transfers`. **Depends on:** ledger, idempotency. Invariant: opposite-direction transfers in parallel never deadlock-fail and money is conserved (tested with 100 simultaneous A→B / B→A, a ring of three, and first-use account creation races).

| Endpoint | Operation |
|---|---|
| `POST /transfers` `{fromUserId, toUserId, currency: IRT\|USDT, amount}` | 422 `SAME_USER` first (not stored). Then ONE transaction: claim key → `ledger.lockUsersAccounts([from, to])` (all accounts, one ascending-id lock order) → sender must hold the amount and owe nothing, else a stored 422 `INSUFFICIENT_FUNDS` → `ledger.post(TRANSFER: sender AVAILABLE −x + creditLines(receiver))`, so the receiver's DEBT is paid off first → `transfers` row → stored 201 `{transferId}`. No fee. The ledger writes the balance events of both users in the same transaction |

### notification
**Owns:** `notifications`. **Depends on:** ledger (read), messaging (inbox). The consumer of balance events (`notify.events`), loaded by the worker.

| Unit | Responsibility |
|---|---|
| `NotificationHandler` | For a `wallet.balance.changed` message, in ONE transaction: `InboxService.markProcessed('notification', messageId)` (false → stop, a duplicate delivery changes nothing), then reload the user's balances and insert one `notifications` row. The message carries ids only (`userId`, `currency`, `journalId`, `kind`), never an amount to act on. Other event types and unreadable payloads are acked and ignored: no retry could change either |

**Balance events.** `LedgerService.post` is the only writer of money, so it is the only emitter: for every journal it books, in the same transaction, it writes one `wallet.balance.changed` outbox row per user whose balance the journal changed (system accounts announce nothing; a duplicate booking, which writes no postings, writes no event). So an event exists exactly when the money moved: a crash after commit leaves the row in the outbox for the relay, and a rollback leaves nothing. Delivery is at least once; the inbox makes the effect exactly once.

### scheduler (worker role)
**Owns:** nothing. Calls the `DueWorkSource` implementations (listed in `SchedulerModule.register`) every `SWEEPER_INTERVAL_MS` (5 s), at once again while a source returns a full batch (`SWEEPER_BATCH_SIZE`, 100).

**`DueWorkSource.claimDue(tx, limit, bumpSeconds)` contract: bump first.** One statement takes due rows `FOR UPDATE SKIP LOCKED`, sets `next_check_at = now() + SWEEPER_BUMP_SECONDS` (30), and returns them; the sweeper commits that, then publishes. So a row is queued once per bump: a parallel sweeper skips it while locked and finds it not due once committed. A publish only starts if, at its worst case, it ends before the bump does (as in the outbox relay), and boot fails if the bump is too short for that.

| Source | Claims (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING`) | Publishes |
|---|---|---|
| Withdrawal due | `next_check_at <= now()`; bumps it 30 s ahead first | `job.withdrawal.submit` if PENDING, else `job.withdrawal.sync` |
| Withdrawal review (`WithdrawalReviewSource`) | non-final, older than `REVIEW_AFTER_MINUTES` (30), not yet flagged; partial index `withdrawals_unflagged_open_idx` | sets `needs_review = STUCK`, logs an `ALERT`; queues nothing, moves no money, leaves `next_check_at` so it is still checked (W14) |
| Deposit due (`DepositDueWork`) | PENDING with `next_check_at <= now()`; bumps it first. Each sync sets the next check by the poll schedule (15 s, 15 s, 30 s, 60 s to 30 min, then 5 min), and expiry is decided by that sync: the handler fails the deposit as `EXPIRED` only if the PSP still says INIT | `job.deposit.sync` |
| Deposit watchdog, abandoned create (`DepositWatchdog`) | CREATED older than `DEPOSIT_ABANDON_AFTER_MINUTES` (10); partial index `deposits_created_idx` | `FAILED (CREATE_ABANDONED)`; the key is left, and a retry with it answers from the failed deposit |
| Deposit watchdog, unverified (`DepositWatchdog`) | PENDING, first seen paid more than `DEPOSIT_UNVERIFIED_ALERT_SECONDS` (120) ago, not yet flagged; partial index `deposits_unverified_idx` | sets `needs_review = UNVERIFIED_TOO_LONG`, logs an `ALERT`; queues nothing, fails nothing, leaves `next_check_at` so a late verify still credits (D13) |
| Cleanup | hourly | idempotency keys (7 d), published outbox (3 d), inbox ids (7 d), inbound events (30 d) |
| Invariants | every 5 min | `operations.InvariantsService.check()`; logs an alert on any violation |

The sweeper publishes directly to RabbitMQ rather than through the outbox. Its work is re-derivable from rows: if a publish fails, or RabbitMQ restarts and loses the queue, the row is due again after the bump and the next sweep queues it (tested by dropping the connection and purging the queue, and with a real `docker compose restart rabbitmq` in `npm run test:chaos`).

## Integrations (ports and adapters)

Services depend on the port (an injection token); the HTTP adapter is the only code that knows URLs, status codes and quirks. Tests swap in fake servers scripted per finding ID.

| Port | Operation | Outcomes |
|---|---|---|
| `PspClient` | `createPayment(amountRial, orderId, callbackUrl)` | `CREATED {token, paymentUrl}` · `REJECTED {code}` · `UNAVAILABLE` |
| | `getPayment(token)` | `{status: INIT \| PAID \| VERIFIED \| FAILED \| REVERSED, amount, refId}` · `NOT_FOUND` · `UNAVAILABLE` |
| | `verify(token)` | `OK {amount, refId}` (100) · `ALREADY_VERIFIED {amount, refId}` (101) · `NOT_PAID` (−51) · `UNAVAILABLE` (503 / −1, timeout) · `NOT_FOUND` (−9) |
| | `getSettlement(date)` (bonus) | rows · `UNAVAILABLE` |
| `PayoutClient` (`integrations/payout`; adapter `HttpPayoutClient`) | `requestBody(req)` (exactly what `submit` sends, so the attempt is recorded first) · `submit({requestId, destinationType, destination, amount})` → `POST /payout/transfers` `{requestId, type: IBAN \| CRYPTO, destination, amount (string), currency}` | `ACCEPTED {snapshot}` (202) · `REPLAYED {snapshot, mismatches}` (200; requestId, amount, currency, destination compared, PAY-02) · `REJECTED {error}` (400, 422) · `AMBIGUOUS {reason}` (503, timeout, reset, any other status, unreadable 2xx). Every outcome carries the wire exchange (request body, HTTP status, response body, error) for `payout_attempts` |
| | `getTransfer(requestId)` → `GET /payout/transfers/{requestId}` | `FOUND {snapshot}` (200) · `NOT_FOUND` (404) · `UNAVAILABLE` (anything else, timeout, unreadable 200) |
| `WebhookVerifier` | `verify(rawBody, signatureHeader)` | boolean, constant-time compare |
| `InboundEvents` | `record(tx?, {source, eventId, reference, signatureValid, headers, rawBody, outcome})` | id |

Adapter rules: one keep-alive HTTP agent per provider; 10 s timeout per call; every request and response logged with the request id (IBAN masked); amounts formatted per currency (IRR integer string; USDT decimal string with ≤ 6 decimals, PAY-01).

## Error catalog

| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | malformed body, bad amount string, unknown currency, bad userId |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | financial POST without the header |
| 400 | `INVALID_DESTINATION` | Sheba or TRC20 fails validation |
| 400 | `INVALID_CURSOR` | ledger cursor can't be decoded |
| 401 | `UNAUTHORIZED` | internal guard on and key wrong or missing |
| 401 | `INVALID_SIGNATURE` | payout webhook HMAC mismatch |
| 404 | `NOT_FOUND` | unknown deposit, withdrawal or route |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | twin request still running |
| 409 | `CANCEL_NOT_ALLOWED` | bonus: cancel after submission |
| 422 | `BELOW_MINIMUM` | under 100,000 toman / 10 USDT / 1,000 toman deposit |
| 422 | `INSUFFICIENT_FUNDS` | available < amount + fee |
| 422 | `DAILY_LIMIT_EXCEEDED` | would pass 200,000,000 toman for the Tehran day |
| 422 | `IDEMPOTENCY_KEY_REUSED` | same key, different body |
| 422 | `SAME_USER` | bonus: transfer to self |
| 500 | `INTERNAL_ERROR` | anything unexpected (logged with the request id, no details leaked) |
| 503 | `SERVICE_BUSY` | lock timeout outside the idempotency claim |
| 503 | `NOT_READY` | `/ready` while a dependency (database) is unreachable |
| 503 | `PROVIDER_UNAVAILABLE` | PSP create failed ambiguously; retry with the same key |

## Folder layout of one module

```
src/modules/withdrawal/
  withdrawal.module.ts          exports WithdrawalService only
  controllers/                  withdrawal.controller.ts · payout-webhook.controller.ts
  dto/                          request and response DTOs, mappers to API units
  domain/                       withdrawal-state-machine.ts · withdrawal-policy.ts (pure, unit-tested)
  services/                     withdrawal.service.ts · withdrawal-outcome.service.ts
  handlers/                     withdrawal-submit.handler.ts · withdrawal-sync.handler.ts
  repositories/                 withdrawals.repository.ts · payout-attempts.repository.ts · daily-limit.repository.ts
  withdrawal.due-work.ts        scheduler source
```