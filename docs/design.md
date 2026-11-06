# T-103 Wallet & Ledger — Design



## 1. Architecture and boundaries
Modular monolith (NestJS) on one PostgreSQL. One image, two roles: **`api`** (HTTP, 2 replicas behind nginx as `app:3000`) and **`worker`** (consumers, outbox relay, schedulers, 2 replicas). PostgreSQL is the only source of truth; RabbitMQ only delivers and can be rebuilt from the database. Modules talk through services, not each other's tables.

| Module | Owns | Responsibility |
|---|---|---|
| ledger | accounts, journals, postings | The only writer of money: `post(tx, journal)` locks, validates, appends, updates balances |
| wallet | — | Balances, keyset-paginated history |
| idempotency | idempotency_keys | Claim, fingerprint, replay |
| deposit | deposits | Create via PSP, callback intake, `deposit.sync` |
| withdrawal | withdrawals, payout_attempts, withdrawal_daily_usage | Request, limits, `withdrawal.submit` / `.sync`, webhook intake |
| operations | adjustments (+ reconciliation) | Manual credit; settlement reconciliation (bonus) |
| messaging | outbox, inbox | Transactional outbox → RabbitMQ; consumer de-duplication |
| integrations | inbound_events | PSP/Payout clients, outcome classification, HMAC, raw evidence |

## 2. Money and ledger
- **Units:** BIGINT minor units, parsed from strings, no floats (enforced by lint). IRT is stored as **rial**: the API speaks toman (×10), while the PSP and payout service both speak rial (PSP-01, PAY-01). USDT is stored as 10⁻⁶.
- **Journals:** one per business event. Postings carry signed amounts and **each journal sums to zero** (deferred trigger). Journals and postings are immutable (trigger); corrections are new journals that reference the original.
- **Accounts:** per user and currency `AVAILABLE`, `FROZEN`, `DEBT`; system `PSP_CLEARING`, `PAYOUT_CLEARING`, `FEE_REVENUE`, `OPS_ADJUSTMENTS`. `CHECK (allow_negative OR balance >= 0)`; only system accounts and `DEBT` may go negative. Balances are updated in the same transaction as their postings, and each posting stores `balance_after`.

## 3. Data model
| Table | Keys / constraints / indexes |
|---|---|
| accounts | UNIQUE NULLS NOT DISTINCT (user_id, kind, currency) · CHECK balance ≥ 0 unless allow_negative |
| journals | UNIQUE (kind, ref_type, ref_id) · partial UNIQUE (ref_id) WHERE kind IN (WD_SETTLE, WD_RELEASE): settled *or* released, never both |
| postings | FK journal, account · amount ≠ 0 · Σ = 0 per journal · no UPDATE/DELETE · INDEX (user_id, id DESC), (account_id, id DESC) |
| idempotency_keys | PK key · fingerprint, status, response_code/body, resource_id, locked_until |
| deposits | PK uuid (= PSP orderId) · UNIQUE psp_token, psp_ref_id · INDEX (next_check_at) WHERE status IN (CREATED, PENDING) |
| withdrawals | PK uuid (= payout requestId, never regenerated) · returned_at · INDEX (next_check_at) WHERE not final · (user_id, created_at) |
| payout_attempts | PK (withdrawal_id, attempt_no) · outcome ACCEPTED / REPLAYED / REJECTED / AMBIGUOUS · raw response |
| withdrawal_daily_usage | PK (user_id, day) · CHECK 0 ≤ used_rial ≤ cap_rial |
| adjustments | amount > 0 · reason NOT NULL · actor · journal_id |
| outbox · inbox | outbox partial INDEX WHERE published_at IS NULL · inbox PK (consumer, message_id) |
| inbound_events | every callback/webhook as received (raw body, signature result), rejected ones too |

## 4. The request path is one transaction
`POST /withdrawals` runs as a single database transaction (READ COMMITTED, `lock_timeout` 3 s). It either fully happens or not at all.

| # | Step | If it fails |
|---|---|---|
| 1 | Validate the destination: Sheba mod-97 or TRC20 base58check (the provider pays invalid addresses, PAY-06) | 400 `INVALID_DESTINATION` |
| 2 | Check the amount against the minimum | `BELOW_MINIMUM` |
| 3 | Claim the idempotency key | A twin request waits and replays the stored response, or gets 409 |
| 4 | Lock the user's accounts (in id order) and the daily-usage row with `SELECT … FOR UPDATE` | — |
| 5 | Check the balance | `INSUFFICIENT_FUNDS` |
| 6 | Check the daily limit | `DAILY_LIMIT_EXCEEDED` |
| 7 | Write everything: `PENDING` withdrawal, FREEZE journal, usage += amount, outbox `withdrawal.submit`, stored response | — |
| 8 | COMMIT | 201 |

Adjustments and transfers have the same shape, minus the background job. DB constraints back up every check.

## 5. Provider rule: a push is a hint, a pull is the truth
**Rule:** money moves only on what we *pull* (`GET` / `verify`), never on what is pushed to us.

- Callbacks and webhooks are stored as received and only trigger a `*.sync` job.
- Webhooks without a valid raw-body HMAC get 401. Forged `FAILED` webhooks exist (PAY-10).
- PSP callbacks cannot be trusted: they are unsigned, about 15 % never arrive, some are duplicated, some say `NOK` for a paid payment, and some carry an `amount` ×10 too large (PSP-05–07).
- Pollers (`next_check_at`) cover every lost push.

## 6. State machines

### Deposit
```
CREATED --PSP 201--> PENDING --sync: PAID/VERIFIED, verify 100/101--> SUCCEEDED
   |                    |
   | PSP 4xx            | PSP FAILED/REVERSED, or INIT after 24 h
   v                    v
 FAILED               FAILED
```
- On success we credit the **verified** amount, not the one in the callback.
- Verify returns 503: retry; the payment is never applied (PSP-09).
- Verify returns `-51` while the PSP says INIT: stay `PENDING` (PSP-08).
- An unverified PAID payment is REVERSED by the PSP after 10–29 min (PSP-10), so verify within seconds and alert after 2 min.
- A payment made after expiry is never verified, so the PSP returns it to the payer.

### Withdrawal
The withdrawal status is the API status.

```
PENDING --worker records attempt--> SUBMITTING --202/200, body matches--> PROCESSING --GET SUCCEEDED--> SUCCEEDED
(frozen, limit reserved)                |                                      |
                                        | 400, then GET 404                    | GET FAILED
                                        v                                      v
                                      FAILED  <------------------------------ FAILED   (funds released)
```

| Situation | What happens |
|---|---|
| 503, timeout or connection reset on submit (PAY-03/04) | Stays `SUBMITTING`; resolved by GET. 200: adopt the provider's record. 404: resubmit with the **same requestId**, which the provider de-duplicates (PAY-02) |
| Bank return after success (PAY-07) | Treated as a new event. Status stays `SUCCEEDED`; a return journal references the withdrawal and sets `returned_at` |
| Stale push (PAY-11) | Ignored. Statuses only move forward and final statuses never change |
| Silence from the provider | **Never fails on silence.** Anything non-final after 30 min is flagged `needs_review` and stays frozen |
| Ambiguity #1: success arrives after `FAILED` | A claw-back journal debits AVAILABLE, then DEBT. Withdrawals are blocked while DEBT < 0. Status is corrected to `SUCCEEDED` and flagged (an audited fix of a wrong record) |

## 7. Assumptions
Where the spec was silent, we decided as follows.

| # | Topic | Assumption |
|---|---|---|
| A1 | Minimum withdrawal | 100,000 toman (configurable) |
| A2 | What counts as a "day" | The Asia/Tehran calendar day, by the database clock |
| | Daily limit usage | Non-final withdrawals count. `FAILED` releases its amount; a returned withdrawal does not |
| A3 | Amounts | Strings. IRT is integer toman; USDT has no trailing zeros |
| | `userId` | 1–64 characters from `[A-Za-z0-9_-]` |
| | Unknown wallet | Returns 200 with zero balances; a GET never creates rows |
| A4 | Internal endpoints | `/internal/*` and `/reconciliation/run` require `X-Internal-Api-Key` only when `INTERNAL_API_KEY` is set |
| A5 | Extra error codes | `VALIDATION_ERROR`, `IDEMPOTENCY_KEY_REQUIRED` (400) · `NOT_FOUND` (404) · `SERVICE_BUSY`, `PROVIDER_UNAVAILABLE` (503) |
| | Minimum deposit | 1,000 toman (PSP-02) |

## 8. Decisions
There are 13 ADRs in `adr/`. These four shape everything else.

| ADR | Question | Options considered | Chosen | Cost we accept |
|---|---|---|---|---|
| 1 | How do we handle concurrency? | Redis lock · optimistic versioning · SERIALIZABLE · row locks | **PostgreSQL row locks** taken in a fixed order, balances updated in the same transaction, CHECK constraints as backstop | One user's requests serialize; hot rows at scale |
| 2 | How do we run async work? | Publish directly · Postgres as queue · BullMQ (Redis) · outbox + RabbitMQ | **Outbox → RabbitMQ quorum queues**, retry times kept in the database | One more container and a relay; delivery is at-least-once, so consumers must be idempotent |
| 3 | Who do we believe about provider state? | Trust pushes · timeout means FAILED · pull and freeze | **Pull to decide, never fail on silence** | Extra GETs; money frozen during outages; a manual-review queue |
| 4 | Which money unit? | NUMERIC + decimal library · integer toman · integer rial | **Integer rial**: matches both providers and can't lose a rial | ×10 conversion at the API edge |

## Changelog
- **v1** (2026-11-03): initial design, informed by the black-box simulator probe.
- **v1.1** (2026-11-04): Kysely added as a typed query builder over TypeORM's transactions (ADR-013).
- **v1.2** (2026-11-06): USDT counts toward the daily cap at a reference rate snapshotted on each withdrawal (ADR-012, Ambiguity #2). Cancel allowed only while `PENDING` (Ambiguity #3).
- **v2** (2026-11-06), after building and running against the hostile simulator:
  - Withdrawal: a GET 404 for a transfer the provider already accepted is not a failure (PAY-14); it is rechecked and flagged `UNKNOWN_AFTER_SUCCESS` only after 30 min (W16–W19). A 200 replay whose fields differ from ours is flagged `REPLAY_MISMATCH` and stays frozen.
  - Deposit: a `CREATED` deposit whose PSP call never completed fails as `CREATE_ABANDONED` after 10 min; a verified bank reference already credited to another deposit is flagged `DUPLICATE_REF` and not credited twice.
  - Not built from v1: the `state_transitions` audit table, and the restricted database role. History is reconstructed from journals, `payout_attempts` and `inbound_events`.
  - The invariant check runs every 5 minutes in the workers and logs an `ALERT` on any violation, besides `GET /internal/invariants` on demand.
  - New documents: `overview.md`, `ambiguities.md`, `incident-analysis.md`, `scalability.md`, `running.md`, `api/openapi.json`, and provider notes v2 with three questions answered.
