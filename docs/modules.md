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
| transfer (bonus) | ledger, idempotency |
| ledger | messaging (balance events) |
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
| `common/guards` | `InternalApiKeyGuard`: active only when `INTERNAL_API_KEY` is set | `/internal/*`, `/reconciliation/run` |
| `common/time` | Business clock from the database | `tehranDay(tx)` → date |
| `database` | DataSource, migration runner, transaction runner | `TransactionRunner.run(fn, {retries})` |
| `health` | Liveness and readiness | `/health`, `/ready` (database + RabbitMQ) |

## Core modules

### ledger
**Owns:** `accounts`, `journals`, `postings`. **Depends on:** messaging (balance events, bonus). **Used by:** every money flow.

| Operation | Input → output | Transaction | Notes / errors |
|---|---|---|---|
| `ensureUserAccounts(tx, userId, currency)` | → account ids for AVAILABLE, FROZEN, DEBT | caller's | `INSERT … ON CONFLICT DO NOTHING`, then select; safe under concurrency |
| `lockUserAccounts(tx, userId, currency)` | → locked balances `{available, frozen, debt}` | caller's | `SELECT … FOR UPDATE` in id order; used for pre-checks |
| `post(tx, journal)` | `{kind, refType, refId, currency, description, lines[{account, amount}]}` → journalId | caller's | Locks the accounts not yet locked, in id order; checks the sum is 0 and no protected balance goes negative; inserts journal + postings with `balance_after`; updates balances. A duplicate `(kind, ref)` returns the existing journal and `alreadyBooked = true`, so callers stay idempotent |
| `creditLines(tx, userId, currency, amount)` | → posting lines | caller's | The only way money reaches a user: DEBT first, the rest to AVAILABLE. Used inside deposit, adjustment and transfer journals |
| `creditUser(tx, userId, currency, amount, sourceAccount, journalMeta)` | → journalId | caller's | Convenience: one journal of `sourceAccount −amount` + `creditLines` |
| `getBalances(userId)` | → per currency `{available, frozen, debt}` | read | No locks, no writes; unknown user returns zeros |
| `listHistory(userId, cursor, limit)` | → postings with journal kind, ref, description; next cursor | read | Keyset on `postings (user_id, id DESC)` |
| `checkLedger()` | → report | read | Journals sum to 0; balance = Σ postings per account; no negative protected balances; `AVAILABLE > 0` only where `DEBT = 0` |

### idempotency
**Owns:** `idempotency_keys`. **Depends on:** nothing but foundation.

| Operation | Input → output | Transaction | Notes / errors |
|---|---|---|---|
| `claim(tx, {key, scope, body})` | → `NEW` \| `REPLAY {status, body}` | caller's | `INSERT … ON CONFLICT DO NOTHING`. A concurrent twin blocks until the first commits, then replays. Different fingerprint → `IDEMPOTENCY_KEY_REUSED` (422). Wait exceeds `lock_timeout` → `IDEMPOTENCY_IN_PROGRESS` (409) |
| `complete(tx, key, status, body, resource)` | → void | caller's | Stores the exact response to replay |
| `claimWithLease({key, scope, body}, seconds)` | → `NEW` \| `REPLAY` \| `IN_PROGRESS` \| `RESUME {resourceId}` | own | Two-phase deposit create only. An expired lease means the earlier attempt died, so the caller resumes it |
| `releaseLease(key)` | → void | own | After a provider failure, so a retry can resume at once |
| `purgeOlderThan(days)` | → count | own | Scheduler, hourly |

What gets stored: 2xx responses and state-dependent 422s (`INSUFFICIENT_FUNDS`, `DAILY_LIMIT_EXCEEDED`). Not stored: 400s and pre-transaction 422s like `BELOW_MINIMUM` (recomputed identically), and 5xx (the transaction rolled back). The `@IdempotencyKey()` parameter decorator rejects a missing header with `IDEMPOTENCY_KEY_REQUIRED` (400).

### messaging
**Owns:** `outbox`, `inbox`. **Depends on:** RabbitMQ.

| Unit | Responsibility |
|---|---|
| `OutboxService.add(tx, {exchange, routingKey, aggregate, payload})` | Writes a message in the caller's transaction (exported) |
| `OutboxRelay` (worker) | Every 200 ms–1 s: claim up to 100 unsent rows (`FOR UPDATE SKIP LOCKED`, set `claimed_until`), publish with confirms, mark `published_at`. Claim expiry after 30 s makes a crashed relay's rows claimable again |
| `RabbitTopology` | Declares exchanges, queues and bindings idempotently at startup |
| `JobConsumer` base | prefetch 10; parses the envelope; calls the handler; **acks only after the handler's transaction commits**. A thrown error nacks with requeue; past the queue's delivery limit (5) the message dead-letters to `job.dead` and is logged. The row's `next_check_at` makes the sweeper retry later regardless |
| `InboxService.markProcessed(tx, consumer, messageId)` | Bonus: returns false if already processed |

**Topology.**

| Exchange | Type | Routing key → queue | Consumer |
|---|---|---|---|
| `wallet.jobs` | direct | `job.withdrawal.submit` → quorum queue of the same name | `WithdrawalSubmitHandler` |
| | | `job.withdrawal.sync` → `job.withdrawal.sync` | `WithdrawalSyncHandler` |
| | | `job.deposit.sync` → `job.deposit.sync` | `DepositSyncHandler` |
| `wallet.dlx` | fanout | → `job.dead` | none (alert + manual) |
| `wallet.events` (bonus) | topic | `wallet.balance.changed`, `deposit.status.changed`, `withdrawal.status.changed` → `notify.events` | `NotificationConsumer` (inbox de-dup) |

**Envelope:** `{messageId, type, aggregateId, occurredAt}`. Ids only: handlers always reload state from the database, so a stale or duplicated message can't move money.

## Business modules

### wallet
**Owns:** nothing. **Depends on:** ledger.

| Endpoint | Operation | Output |
|---|---|---|
| `GET /wallets/:userId` | `WalletService.getWallet(userId)` → `ledger.getBalances` | `200 {userId, balances: [{currency: "IRT" \| "USDT", available, frozen, total, debt}]}`; total = available + frozen |
| `GET /wallets/:userId/ledger?limit&cursor` | `WalletService.getHistory` → `ledger.listHistory` | `200 {items: [{id, journalId, type, bucket, currency, amount, balanceAfter, reference: {type, id}, description, createdAt}], nextCursor}`; limit 1–100, default 20; cursor is opaque base64url of the last posting id; a bad cursor gives 400 `INVALID_CURSOR` |

### operations
**Owns:** `adjustments` (+ `reconciliation_*`, bonus). **Depends on:** ledger, idempotency, withdrawal (open totals for the invariant check), psp (bonus).

| Endpoint | Operation | Transaction | Notes |
|---|---|---|---|
| `POST /internal/adjustments` | `AdjustmentsService.create({userId, currency, amount, reason, actor}, key)` | one: claim → ensure accounts → insert adjustment → `ledger.creditUser` (ADJUSTMENT_CREDIT) → complete | `201 {adjustmentId, journalId, userId, currency, amount}`; guard; `reason` 3–500 chars |
| `GET /internal/invariants` | `InvariantsService.check()` = `ledger.checkLedger()` + FROZEN equals `withdrawal.openTotals()` per user and currency | read | For the live demo and alerts. Lives here, not in ledger, so the ledger never depends on withdrawal |
| `GET /internal/reviews` | lists deposits and withdrawals with `needs_review` | read | Optional ops view |
| `POST /reconciliation/run` (bonus) | `ReconciliationService.run(date)` | own | Fetch CSV, match by refId, store run + mismatches, change no money; no Idempotency-Key |

### withdrawal
**Owns:** `withdrawals`, `payout_attempts`, `withdrawal_daily_usage`. **Depends on:** ledger, idempotency, messaging, payout, inbound events.

| Unit | Responsibility |
|---|---|
| `WithdrawalController` | `POST /withdrawals`, `GET /withdrawals/:id`, `POST /withdrawals/:id/cancel` (bonus) |
| `PayoutWebhookController` | `POST /webhooks/payout`: raw-body HMAC, record, schedule sync, 200 |
| `WithdrawalService` | `request`, `get`, `cancel`, `openTotals()` (Σ amount + fee of non-final withdrawals per user and currency) |
| `WithdrawalPolicy` (domain) | Minimum, fee and limit amount per currency; destination type per currency |
| `WithdrawalStateMachine` (domain) | The transition table in `state-machines.md`; `next(status, event)` |
| `WithdrawalOutcomeService` | Applies a provider snapshot: journals, status, flags, `next_check_at`, transition row, events |
| `DailyLimitRepository` | `reserve`, `release` on `withdrawal_daily_usage` |
| `WithdrawalSubmitHandler` | Consumer of `job.withdrawal.submit` |
| `WithdrawalSyncHandler` | Consumer of `job.withdrawal.sync` |
| `WithdrawalDueWork` | Implements the scheduler's `DueWorkSource` |

**`request(cmd, key)`**, one transaction (ADR-1). Before the transaction: DTO validation (400), destination validation (400 `INVALID_DESTINATION`), minimum (422 `BELOW_MINIMUM`). Then:
1. `idempotency.claim` (replay → return the stored response).
2. `ledger.ensureUserAccounts` + `lockUserAccounts`.
3. `available < amount + fee` → stored 422 `INSUFFICIENT_FUNDS`.
4. `DailyLimitRepository.reserve(tx, userId, tehranDay, limitAmount)` (creates and locks the row) → over the cap: stored 422 `DAILY_LIMIT_EXCEEDED`.
5. Insert the withdrawal (`PENDING`, `next_check_at = now + 30 s` as a safety net), `ledger.post(WITHDRAWAL_FREEZE)`, transition row, `outbox.add(job.withdrawal.submit)`.
6. `idempotency.complete(201 {withdrawalId, status: "PENDING"})`, then commit.

**`get(id)`:** `200 {withdrawalId, status, userId, currency, amount, fee, destination (masked), failureReason, returnedAt, returnReason, needsReview, createdAt, updatedAt}`; unknown → 404 `NOT_FOUND`.

**`WithdrawalSubmitHandler`:**
1. Transaction 1: lock the withdrawal row (`FOR UPDATE SKIP LOCKED`; locked means another worker has it, so ack and stop). Continue only if `PENDING`, or `SUBMITTING` with no in-flight attempt. Move to `SUBMITTING`, open attempt n, set `next_check_at = now + 30 s`. Commit.
2. `PayoutClient.submit` (10 s timeout).
3. Transaction 2: close the attempt with its outcome, then by outcome:
   - `ACCEPTED`, or `REPLAYED` with matching fields → `PROCESSING`.
   - `REPLAYED` with different fields → stays `SUBMITTING`, `needs_review = REPLAY_MISMATCH`.
   - `REJECTED` → schedule an immediate sync. FAILED only after a GET confirms 404.
   - `AMBIGUOUS` → stays `SUBMITTING`, `next_check_at` by backoff.

**`WithdrawalSyncHandler`:**
1. Read the row. A non-final status, `SUCCEEDED` within the return window, or any status when a signed webhook triggered the job (that is how W12 is found) needs a GET; anything else acks and stops.
2. `PayoutClient.getTransfer`:
   - a snapshot goes to `WithdrawalOutcomeService.apply`;
   - `NOT_FOUND` while `SUBMITTING` with no in-flight attempt → enqueue submit with the same requestId;
   - `NOT_FOUND` after the provider had accepted it → `needs_review`;
   - unavailable → reschedule.

**`PayoutWebhookController`:**
1. Verify `x-signature` = hex HMAC-SHA256(raw body, secret) in constant time. Invalid → `inbound_events` (`REJECTED_SIGNATURE`) and 401.
2. Valid → record it; look up the withdrawal by `requestId`. Unknown → `UNKNOWN_REFERENCE`, 200. Known → `next_check_at = now()` plus outbox `job.withdrawal.sync`, 200. Target: under 50 ms.

### deposit
**Owns:** `deposits`. **Depends on:** ledger, idempotency, messaging, psp, inbound events.

| Unit | Responsibility |
|---|---|
| `DepositController` | `POST /deposits`, `GET /deposits/:id` |
| `PspCallbackController` | `POST /webhooks/psp/callback/:depositId` (the `callbackUrl` we give the PSP carries our id) |
| `DepositService` | `create`, `get` |
| `DepositStateMachine` (domain) | Transition table |
| `DepositSyncHandler` | Consumer of `job.deposit.sync` |
| `DepositDueWork` | `DueWorkSource`: due checks, expiry, the 2-minute unverified alert, abandoned creates |

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
4. Always answer 200. The callback's `status` and `amount` are ignored (PSP-06/07).

**`DepositSyncHandler`:**
1. `PspClient.getPayment(token)`.
2. By the PSP status:
   - `INIT` → reschedule; once `expires_at` has passed → `FAILED (EXPIRED)`.
   - `PAID` or `VERIFIED` → `verify`. On `OK` (100) or `ALREADY_VERIFIED` (101), in one transaction: lock the deposit (compare-and-set PENDING → SUCCEEDED), `ledger.creditUser(DEPOSIT_CREDIT, verified amount)`, set `psp_ref_id` and `credited_rial`, transition row; `needs_review = AMOUNT_DIFFERS` if the verified amount ≠ requested. `UNAVAILABLE` (503) → retry in 5 s. `NOT_PAID` (−51) → re-read the status next round.
   - `FAILED` → `FAILED (PSP_FAILED)`.
   - `REVERSED` → `FAILED (PSP_REVERSED)`.

### transfer (bonus)
**Owns:** `transfers`. **Depends on:** ledger, idempotency.

| Endpoint | Operation |
|---|---|
| `POST /transfers` | One transaction: claim key → reject self-transfer (422 `SAME_USER`) → lock both users' accounts in id order → check sender available → `ledger.post(TRANSFER: sender AVAILABLE −x + creditLines(receiver))` → 201 `{transferId}` |

### scheduler (worker role)
**Owns:** nothing. Calls the `DueWorkSource` implementations every 5 s.

| Source | Claims (`UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED LIMIT 100) RETURNING`) | Publishes |
|---|---|---|
| Withdrawal due | `next_check_at <= now()`; bumps it 30 s ahead first | `job.withdrawal.submit` if PENDING, else `job.withdrawal.sync` |
| Withdrawal review | non-final and older than 30 min, not yet flagged | sets `needs_review = STUCK`, logs an alert |
| Deposit due | `next_check_at <= now()` | `job.deposit.sync` |
| Deposit expiry | PENDING, `expires_at <= now()` | sync first; the handler fails it as `EXPIRED` only if the PSP still says INIT |
| Deposit abandoned create | CREATED older than 10 min | `FAILED (CREATE_ABANDONED)`, key completed with that response |
| Cleanup | hourly | idempotency keys (7 d), published outbox (3 d), inbound events (30 d) |
| Invariants | every 5 min | `operations.InvariantsService.check()`; logs an alert on any violation |

The sweeper publishes directly to RabbitMQ rather than through the outbox. Its work is re-derivable from rows: if a publish fails, the next sweep finds the row again.

## Integrations (ports and adapters)

Services depend on the port (an injection token); the HTTP adapter is the only code that knows URLs, status codes and quirks. Tests swap in fake servers scripted per finding ID.

| Port | Operation | Outcomes |
|---|---|---|
| `PspClient` | `createPayment(amountRial, orderId, callbackUrl)` | `CREATED {token, paymentUrl}` · `REJECTED {code}` · `UNAVAILABLE` |
| | `getPayment(token)` | `{status: INIT \| PAID \| VERIFIED \| FAILED \| REVERSED, amount, refId}` · `NOT_FOUND` · `UNAVAILABLE` |
| | `verify(token)` | `OK {amount, refId}` (100) · `ALREADY_VERIFIED {amount, refId}` (101) · `NOT_PAID` (−51) · `UNAVAILABLE` (503 / −1, timeout) · `NOT_FOUND` (−9) |
| | `getSettlement(date)` (bonus) | rows · `UNAVAILABLE` |
| `PayoutClient` | `submit({requestId, type, destination, amount, currency})` | `ACCEPTED {snapshot}` (202) · `REPLAYED {snapshot}` (200) · `REJECTED {error}` (400) · `AMBIGUOUS {reason}` (503, timeout, reset) |
| | `getTransfer(requestId)` | `FOUND {status, reason, amount, trackingId}` · `NOT_FOUND` · `UNAVAILABLE` |
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