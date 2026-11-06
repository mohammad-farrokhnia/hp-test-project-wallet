# Ambiguities


| # | Question | Decision in one line | Code | Tests |
|---|---|---|---|---|
| 1 | A withdrawal we declared FAILED turns out to have succeeded after the user withdrew the money again | Correct the record to SUCCEEDED, claw back what is available, book the rest as DEBT, block withdrawals until it is repaid, flag for review. The earlier decision to change is "fail on silence", and the design never makes it | `withdrawal-sync.handler.ts`, `withdrawal-state-machine.ts`, `ledger/domain/credit.ts` | `withdrawal-sync.handler.int.spec.ts`, `withdrawal-state-machine.spec.ts`, `credit.spec.ts` |
| 2 | Which rate converts USDT to toman for the daily cap, whether a failed withdrawal counts, and when the day starts | A configured reference rate, rounded up and snapshotted on the withdrawal; failed and cancelled withdrawals give their share back, returned ones do not; the day is the Asia/Tehran calendar day by the database clock | `withdrawal-policy.ts`, `daily-limit.repository.ts`, `common/time/tehran-day.ts` | `withdrawal-policy.spec.ts`, `daily-limit.int.spec.ts` |
| 3 | At which stages may a user cancel a withdrawal | Only while it is `PENDING`, before any attempt to pay it. From `SUBMITTING` onwards the answer is 409 `CANCEL_NOT_ALLOWED` | `withdrawal.service.ts` (`cancel`), `withdrawals.repository.ts` (`cancelIfPending`) | `withdrawal-cancel.int.spec.ts` |

---

## Ambiguity #1: a late success after FAILED

### The problem

A withdrawal of amount *x* gets no answer from the payout service for a long time. The system declares it FAILED and releases the frozen money. The user withdraws the same money again, and that second withdrawal is paid. Later the payout service reports that the first transfer succeeded as well. The money has left twice, and the user's balance no longer contains *x*.

### Which earlier decision was wrong

The mistake is declaring the first withdrawal FAILED because the provider was silent. Silence is not an answer. My probe of the simulator showed that this is not a theoretical concern:

- About 45 % of payout creates that returned 503 had in fact created the transfer (PAY-03).
- Every create that timed out or had its connection reset had created the transfer (PAY-04).
- Forged, unsigned `FAILED` webhooks arrive for transfers that succeeded (PAY-10).

The design never fails a withdrawal on silence, on a timeout, on a 503 or on an unverified push (ADR-003):

1. The `requestId` sent to the provider is the withdrawal id. It is saved before the first call and never regenerated, and the provider de-duplicates on it (PAY-02). A resubmit can therefore never create a second transfer.
2. An ambiguous submit leaves the withdrawal in `SUBMITTING`. It is resolved by our own `GET`: a 200 adopts the provider's record, and a 404 resubmits with the same `requestId`.
3. Webhooks need a valid HMAC over the raw body, and even a valid one only schedules a `GET`.
4. After 30 minutes without a definitive answer the withdrawal is flagged `needs_review = STUCK` and an alert is logged. The money stays frozen.

With these rules the second withdrawal in the scenario is refused with `INSUFFICIENT_FUNDS`, because the first one still holds the money in FROZEN.

### What the system does if it happens anyway

The scenario can still arise through paths the design does not control: a provider that contradicts its own earlier answer, a FAILED status set by hand during an incident, or data migrated from an older system. If our own `GET` reports `SUCCEEDED` (or `RETURNED`) for a withdrawal that is FAILED, transition W12 runs in one transaction:

1. A `WITHDRAWAL_LATE_SUCCESS` journal is booked: PAYOUT_CLEARING +*x*, the user's AVAILABLE −min(available, *x*), the user's DEBT −(the rest). The journal sums to zero like every other journal.
2. The withdrawal's status is corrected to `SUCCEEDED`, `late_success_at` is set, `failure_reason` is cleared, and it is flagged `needs_review = LATE_SUCCESS` with an alert in the log.
3. The daily limit is not reserved again. The money left on the original day, and re-reserving it now would refuse the user's legitimate withdrawals for a reason they cannot see.

From then on:

- AVAILABLE never goes negative. The database CHECK still holds.
- The debt is visible on `GET /wallets/{userId}` as `debt`.
- Every later credit (deposit, transfer in, adjustment) pays the debt off first. Only the remainder reaches AVAILABLE (`creditLines` in `ledger/domain/credit.ts`).
- A withdrawal request from a user with debt in that currency is refused with `INSUFFICIENT_FUNDS` and the message "Outstanding debt must be repaid before withdrawing".

### Options I rejected

| Option | Why not |
|---|---|
| Keep FAILED and ignore the report | The books would say the money is still with us while it is in someone's bank account |
| Let AVAILABLE go negative | User can never be allowed to withdraw or spend more than his/her available money |
| Write it off as a company loss | Loses money silently, with nothing to audit or recover |

### The cost

- A final status changes in this one case. The change is visible through `late_success_at`, the `LATE_SUCCESS` review flag, the alert, and the `WITHDRAWAL_LATE_SUCCESS` journal, which references the withdrawal.
- Recovering a debt the user never repays by depositing is an operations and legal process outside this service.

---

## Ambiguity #2: the daily limit

The cap is fixed at 200,000,000 toman per user per day, and leaves three things open.

### Which rate converts USDT to toman

**Decision.** A reference rate set by configuration (`USDT_IRT_REFERENCE_RATE`, toman per 1 USDT, default 100,000). The counted amount is `ceil(amount_micro × rate_rial / 1,000,000)`, so even a dust amount counts at least 1 rial. The fee is not counted, because it never leaves to the user's destination.

**Why.** The service has no market-data source. A rate fetched live at request time would put an external call inside the withdrawal transaction, which the design forbids, or make the limit depend on a service that can be down. A configured rate is predictable, testable and easy to explain to an auditor.

**Protection against a rate change.** The rate and the amount it produced are saved on the withdrawal row (`limit_rate_rial_per_usdt`, `limit_amount_rial`). When the withdrawal fails or is cancelled, exactly that stored amount is released. If an operator changes the rate between the request and the failure, the counter is still correct.

**What I accept.** The cap is exact for IRT and approximate for USDT, by as much as the configured rate differs from the market. In production the rate would be refreshed by a job from the exchange's own price feed, and the snapshot on each row would keep the accounting correct.

### Does a failed withdrawal count

**Decision.** The amount is reserved when the withdrawal is accepted, so `PENDING`, `SUBMITTING` and `PROCESSING` withdrawals count. A withdrawal that ends `FAILED` (provider rejected it, or the user cancelled it) gives its share back. A withdrawal that `SUCCEEDED` keeps it, even if the bank later returns the money.

**Why.** The limit exists to bound how much money leaves per day. A failed withdrawal moved nothing. A returned one did leave, and came back by a separate bank event; releasing the cap on a return would let the same user send the money out again the same day, which is the behaviour the limit is meant to stop.

Reserving at request time rather than at success is what makes the cap hold under 100 concurrent requests: the check and the reservation happen under the same row lock, and a `CHECK (used_rial ≤ cap_rial)` on the counter row backs it up.

### When does the day start

**Decision.** At 00:00 Asia/Tehran (UTC+03:30, no daylight saving since 2022), computed from the database clock with `now() AT TIME ZONE 'Asia/Tehran'`.

**Why.** The users and the business are in Iran; a UTC day would reset at 03:30 local time, which no user would expect. Using the database clock means every API instance agrees on the date, however their own clocks drift.

**What I accept.** A calendar day allows two full caps within a few minutes around midnight. A rolling 24-hour window avoids that but is harder to explain to a user and needs a time-ordered sum inside the hot transaction. ADR-012 records the comparison.

---

## Ambiguity #3: cancelling a withdrawal

### Decision

`POST /withdrawals/{id}/cancel` (with an `Idempotency-Key`) succeeds only while the withdrawal is `PENDING`. It moves it to `FAILED` with `failure_reason = CANCELLED`, releases the frozen amount and fee, and gives back the daily-limit share, all in one transaction. From `SUBMITTING` onwards it answers 409 `CANCEL_NOT_ALLOWED`. Cancelling a withdrawal that is already cancelled returns 200 with the same body.

### Why the line is at PENDING

`PENDING` means no worker has tried to pay it yet, so nothing exists at the provider. The moment the worker claims it (`SUBMITTING`), the attempt is recorded before the HTTP call, and from then on the provider may hold the transfer even if we never saw its answer (PAY-03, PAY-04). The payout API has no cancel endpoint. If we released the money at that point, a transfer that completes later would be exactly the Ambiguity #1 scenario, created by our own decision.

### Race with the worker

The cancel and the submit job both lock the withdrawal row. The cancel uses a compare-and-set (`UPDATE … WHERE status = 'PENDING'`), and the submit job claims the row with `FOR UPDATE SKIP LOCKED`. Whichever commits first wins: either the worker finds the row `FAILED` and does nothing, or the cancel finds it `SUBMITTING` and answers 409. `withdrawal-cancel.int.spec.ts` races the cancel against the submit job 30 times and checks that exactly one of them wins each time, with the money matching what was sent.

### What I accept

In practice the window is short: the submit job is published by the outbox relay within about a second. Cancellation is mainly useful when the workers or the broker are down, which is when a user is most likely to want it.
