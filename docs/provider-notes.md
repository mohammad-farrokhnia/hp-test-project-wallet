# Provider notes: PSP and payout simulator

This file records the behaviour of `hamtapay/t103-simulator:1.0` that we **observed** and that **changed the design**. Every item has evidence: a curated excerpt in `docs/evidence/<ID>.jsonl`, taken from the raw probe logs.

**How it was collected.** Black-box probing on 2026-11-02, before any application code was written. Four simulators ran side by side: `off`, `default` and `hostile` at time scale 1, plus `hostile` at scale 10 (written ×10 below). One run took 9.5 minutes, made 7,670 requests and received 1,064 callbacks and webhooks. We only used the documented endpoints and never looked inside the image. The probe scripts were throwaway tools and are not part of the repository; the curated excerpts in `docs/evidence/` are. A second, smaller round on 2026-11-06 answered three of the open questions at the end of this file (marked *v2*), and the chaos runs in `tools/hardening/chaos.mjs` added one observation (PAY-14).

## Summary

| ID | Behaviour | Modes | Design response |
|---|---|---|---|
| PSP-01 | Amounts are **rial** | all | Store rial internally; API toman ×10 |
| PSP-02 | Positive integer only; minimum exactly 10,000 rial (*v2*); no maximum | all | Our own validation; minimum deposit 1,000 toman |
| PSP-03 | `orderId` is neither validated nor de-duplicated | all | Never rely on the PSP for idempotency; one token per deposit |
| PSP-04 | Callback `{token, orderId, status: OK\|NOK}`, **unsigned** | all | A callback is only a hint |
| PSP-05 | Callbacks **missing** for 13–17 % of paid payments; duplicated up to 5×; no retry on our 500 | default, hostile | Poller is mandatory; idempotent intake |
| PSP-06 | First callback says **NOK for a payment that was paid** | default, hostile | Never fail a deposit on a callback |
| PSP-07 | Some callbacks carry a forged **`amount` ×10** | default, hostile | Credit only the verified amount |
| PSP-08 | verify: 100 OK, 101 ALREADY_VERIFIED (idempotent); **−51 for INIT too** | all | `−51` alone never fails a deposit; check status |
| PSP-09 | verify **503** (8–15 %) is not applied | default, hostile | Retry verify quickly |
| PSP-10 | Unverified PAID becomes **REVERSED** (10–29 min real); INIT never expired | hostile ×10 / all | Verify within seconds; our own 24 h expiry |
| PSP-11 | Paying twice → 409 `−10` | all | — |
| PSP-12 | **Settlement file** `GET /psp/settlement?date=YYYY-MM-DD`: UTF-8 CSV with a BOM, a Persian header, Jalali dates, Persian or Latin digits, bank reference padded to 13 digits or with spaces or bare, one repeated row and one row that is not ours | all | Normalise before matching; report every row; never act on it |
| PAY-01 | Create → **202 ACCEPTED**; IRR integer; USDT as a decimal **string** ≤ 6 dp | all | Adapter formats per currency |
| PAY-02 | **De-duplicates on `requestId`** (sequential and concurrent); a replay with a different amount silently returns the original; also after a final status (*v2*) | all | One requestId per withdrawal, never reused; compare the replay body |
| PAY-03 | **503 but created** (~45 % of 503s) | default, hostile | 503 = ambiguous → resolve by GET or same-id resubmit |
| PAY-04 | **Timeouts and connection resets: every one was created** | default, hostile | Never fail on timeout |
| PAY-05 | No read-after-write lag after 202 | all | GET is usable for resolution |
| PAY-06 | **Destination not validated**; bad IBAN fails later (INVALID_IBAN); **bad TRC20 is paid** | all | Our own Sheba mod-97 and TRC20 checksum → 400 |
| PAY-07 | **SUCCEEDED → RETURNED** (ACCOUNT_CLOSED) 30–180 s later | default, hostile | Status stays SUCCEEDED; separate return journal |
| PAY-08 | Settles in 15–25 s typically, up to ~9 min; some stuck PROCESSING > 7 min | hostile | Backoff polling; `needs_review` at 30 min |
| PAY-09 | Webhook body and `x-signature` = hex HMAC-SHA256(raw body) | all | Verify on raw bytes, constant time |
| PAY-10 | **Forged FAILED webhooks** (bad signature) for transfers that SUCCEEDED | default, hostile | 401 + logged; pull before moving money |
| PAY-11 | Webhooks duplicated (≤ 14×), replayed, **out of order** | all | Forward-only state machine |
| PAY-12 | Webhook retries: after ~1 s on 500; on a slow answer at ~11/23/37/55/81 s | all | Answer fast (record, enqueue, 200) |
| PAY-13 | Webhooks arrive for transfers whose create got 503 or timed out | default, hostile | requestId saved **before** the call, so they resolve |
| PAY-14 | A transfer that was accepted can answer GET **404 for a while** afterwards | hostile | A 404 on a known transfer never fails it; flagged only after 30 min |

## PSP (payment gateway)

**PSP-01 · amounts are rial.** Creating a payment for `1000000` shows "مبلغ قابل پرداخت: ۱۰۰٬۰۰۰ تومان" (100,000 toman) on the payment page. *Design:* rial internally; PSP amount = toman × 10. → `evidence/PSP-01-amount-is-rial.jsonl`

**PSP-02 · amount validation.** `1000` → 400 `{"code":-12,"message":"amount below minimum"}`; `10000` → 201. `1500.5`, `"1e6"` and `"1000000.0"` → 400 `-11`. `10^13` → 201 (no maximum). Numbers and numeric strings are both accepted. *v2:* a binary search between 1,001 and 10,000 found the boundary exactly: 9,999 → 400 `-12`, 10,000 → 201. *Design:* our minimum deposit is 1,000 toman (= 10,000 rial), so a user gets our own `BELOW_MINIMUM` rather than a PSP error, and amounts are sent as integer strings. → `evidence/PSP-02-amount-validation.jsonl`, `evidence/PSP-02-exact-minimum.jsonl`

**PSP-03 · orderId is not an idempotency key.** The same `orderId` posted three times (once with a different amount) returned three different tokens. An empty or missing `orderId` is accepted. *Design:* `orderId = depositId`, used for correlation only. Retrying `POST /deposits` is protected by our own idempotency, not the PSP's.

**PSP-04/05 · callbacks are unsigned and unreliable.**
- The body is `{token, orderId, status}`, with no signature or auth header. It arrives 0.25–2 s after payment.
- In default and hostile modes, **13–17 % of paid payments never got a callback** during the run, while verify succeeded for them. Others got up to 5 copies.
- When we answered 500, the PSP did **not** retry (default mode).

*Design:* a callback only enqueues `deposit.sync`. A poller checks every PENDING deposit.

**PSP-06 · callbacks lie.** A payment that is `PAID` (and later verifies with `code 100`) received `status:"NOK"` as its first callback. This happened 4 times in default, 3 in hostile and 7 in hostile ×10. *Design:* a deposit becomes FAILED only when PSP **status** says FAILED or REVERSED.

**PSP-07 · forged amount.** Some callbacks contain `"amount":"10000000"` for a 1,000,000 payment, while verify returns `1000000`. *Design:* only verify's amount is credited.

**PSP-08 · verify semantics.**
- `100 OK {amount, refId}` the first time, then `101 ALREADY_VERIFIED` with the same `refId`. 5 concurrent verifies gave exactly one 100.
- **`-51 "FAILED"` (HTTP 200) is also returned for a payment still in INIT.** The `verify-before-pay` case was later paid and verified normally.

*Design:* 100 and 101 both mean credit (idempotent). `-51` triggers a status GET; it is not a failure.

**PSP-09 · verify 503.** `{"code":-1,"message":"service unavailable"}` for 8–15 % of verify calls. The next verify returned **100, not 101**, so the 503 was not applied. *Design:* a 503 is retried within seconds.

**PSP-10 · reversal window.**
- At ×10, payments PAID and never verified became `REVERSED` within 173 s, which is ≤ 29 min real.
- At ×1 they were still PAID after 572 s, which is ≥ 9.5 min.
- INIT payments never expired (~95 simulated minutes).

*Design:* PAID deposits are verified as soon as they are seen, with an alert at 2 min. Deposits still INIT after 24 h are expired by us; a later payment is never verified, so the PSP returns it to the payer. **Precise window: probe 2.**

**PSP-11 ·** paying an already processed token → 409 `{"code":-10,"message":"already processed"}`.

Status vocabulary: `INIT → PAID → VERIFIED`, `INIT → FAILED`, `PAID → REVERSED`. Error codes: `-1` (503), `-9` unknown token (404), `-10`, `-11`, `-12`, `-13` callbackUrl required, `-51`.

**PSP-12 · settlement file.** `GET /psp/settlement` (also `?date=YYYY-MM-DD`, `/psp/settlement/{date}` and `.csv`) answers 200 `text/csv; charset=utf-8`, UTF-8 **with a BOM**, CRLF, header `ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح` (row, date, tracking number, type, amount in **rial**, description). In all three modes (`off`, `default`, `hostile`) the file looked the same:
- **Which payments:** only those we **verified** (VERIFIED). A payment that is only PAID, INIT, or whose verify answered 503 is not listed. A payment verified twice is listed once. The description is `پرداخت اینترنتی <token>`, the PSP token.
- **The bank reference** is our `refId`, written differently per row, cycling through four styles: zero-padded to 13 digits (`0003005946226`), padded with spaces (` 2927489111 `), or bare. Compare without padding.
- **Digits and separators** alternate too: Persian digits and `٬` (U+066C), or Latin digits and `,`; the date is the Jalali one (`۱۴۰۵/۰۸/۱۵` or `1405/08/15`). The amount is quoted.
- **Noise injected into every file:** one row repeated verbatim (same row number), and one extra row for a payment that is not ours (description `پرداخت اینترنتی نامشخص`, "unknown").
- **The day** is the Tehran calendar day on which the payment was verified. `date` is Gregorian ISO; no date, an empty one or text means today in Tehran. A Jalali date gives garbage and a day that does not exist gives a row dated `NaN/NaN/NaN`. A day with none of our payments still lists the injected row.
- The same request twice gives the same file.
*Design:* parse every row (never skip one), match by reference without padding, check each row carries the requested day, report repeated, unreadable, unknown and differing rows; change nothing. → `evidence/PSP-12-settlement-csv.jsonl`

## Payout

**PAY-01 · create.** `202 {requestId, trackingId, status:"ACCEPTED", reason, amount, currency, destination, updatedAt}`. IRR accepts an integer number or string. USDT must be a decimal **string** with ≤ 6 dp (`10.5` as a number → 400). Errors look like `{error, message}`: `INVALID_REQUEST_ID` (length outside 8–64), `INVALID_AMOUNT`, `INVALID_TYPE`.

**PAY-02 · de-duplication by requestId.** Resubmitting a requestId returns **200** with the original transfer. 10 concurrent submits produced exactly one 202. A resubmit with a **different amount also returned 200 with the original amount**, silently. *Design:* the requestId is the withdrawal id, saved before the first call and never regenerated. A replayed response is compared field by field with ours; any mismatch is flagged for review.

*v2:* de-duplication also holds **after a final status**. A transfer that reached SUCCEEDED was resubmitted twice with the same requestId, once with the same amount and once with double the amount. Both answers were 200 with the original transfer (original amount, status SUCCEEDED), and a GET afterwards showed the same single transfer. So a late resubmit by our sync can never create a second payout. → `evidence/PAY-02-requestid-dedup.jsonl`, `evidence/PAY-02-resubmit-after-final.jsonl`

**PAY-03/04 · failures that still created the transfer.**
- 13–15 % of creates got `503 {"error":"UPSTREAM_UNAVAILABLE"}`. About 45 % of those transfers **existed afterwards**: GET returned them and webhooks arrived.
- **All** requests that hung (30 s client timeout) or were reset by the server (hostile ×10) had created the transfer.

*v2:* a follow-up sample in default mode looked at 12 creates that answered 503 and whose immediate GET was 404. All 12 were still 404 after 5 s and after 25 s; none appeared later. In this sample a 404 right after a 503 meant the transfer did not exist. The design does not depend on it: a 404 leads to a resubmit with the same requestId, which PAY-02 makes safe either way. → `evidence/PAY-03-404-after-503-stays-404.jsonl`

*Design:* 503, timeout and reset are classified **AMBIGUOUS**. The withdrawal stays SUBMITTING and is resolved by GET (200 → adopt) or by a resubmit with the same requestId (404 → safe because of PAY-02). It is never FAILED by timeout.

**PAY-05 ·** a GET immediately after a 202 always found the transfer.

**PAY-06 · destinations are not validated up front.** A Sheba with a bad checksum and a malformed `IR123` were both accepted (202) and later went `FAILED` with reason `INVALID_IBAN`. Lowercase and spaced IBANs were accepted and SUCCEEDED. **A TRC20 address with a broken checksum was accepted and SUCCEEDED.** *Design:* we validate Sheba (normalise, `IR`+24 digits, mod-97) and TRC20 (base58check, prefix 0x41) ourselves → 400 `INVALID_DESTINATION`.

**PAY-07 · returns.** In hostile mode, transfers went `SUCCEEDED → RETURNED` (`reason: ACCOUNT_CLOSED`) 30–180 s after success. RETURNED can also be the first final status we see. *Design:* the payout did succeed, and the return is a separate bank event, like a statement showing the debit and later a credit "return of transaction x". The withdrawal stays `SUCCEEDED`; a return journal (PAYOUT_CLEARING → AVAILABLE) references it and `returned_at` / `return_reason` are set. If RETURNED is the first final status we see, settle and return are booked together. Successful withdrawals keep being watched for returns.

**PAY-08 · timing.** Create → first signed final webhook: p50 15–22 s; p90 27 s (off) and 280 s (hostile); max ≈ 9 min. Three hostile transfers were still `PROCESSING` after 7–8 min. *Design:* polling with backoff; `needs_review` after 30 min; never auto-fail.

**PAY-09 · webhook format.** `{event:"transfer.updated", eventId, requestId, trackingId, status, reason, amount, currency, occurredAt}`. Headers are `x-signature` (hex HMAC-SHA256 of the raw body with `WEBHOOK_SECRET`) and `x-event-id` (= `eventId`). All genuine signatures validated over the raw bytes.

**PAY-10 · forged webhooks.**
- Default (3), hostile (5) and hostile ×10 (9) delivered webhooks with an **invalid signature**, `status:"FAILED"` and no `reason` field.
- For **every one**, GET showed the transfer `SUCCEEDED`.
- Trusting them would release the frozen funds of a paid transfer, which is a double payout. This is Ambiguity #1 in practice.

*Design:* 401 plus an audit row in `inbound_events`. Even signed webhooks only trigger a GET.

**PAY-11 · duplicates and ordering.** Up to 14 deliveries per transfer. Whole histories were replayed (`PROCESSING, SUCCEEDED, PROCESSING, SUCCEEDED…`), and `PROCESSING` arrived after `SUCCEEDED`. Redeliveries reuse `eventId`, but the same status was sometimes re-sent with a new `eventId`. Signed webhooks never moved FAILED or RETURNED back to SUCCEEDED. *Design:* a forward-only state machine; `eventId` is recorded for audit but correctness doesn't depend on it.

**PAY-12 · retry policy.** When we answered 500, the same status was redelivered ~1 s later. When we answered after 15 s, it was treated as failed and retried at ~11, 23, 37, 55 and 81 s. *Design:* the webhook endpoint only verifies, records and enqueues, then returns 200 in milliseconds.

**PAY-13 ·** webhooks arrived for transfers whose create had returned 503 or timed out. Because the requestId is saved before the call, these resolve the right withdrawal.

**PAY-14 · a GET 404 on a transfer that exists.** Seen during the hostile chaos runs (`tools/hardening/chaos.mjs`), not in the first probe: a transfer whose create had timed out answered GET with 404 for a while, and later appeared as PROCESSING and then SUCCEEDED. A transfer already reported SUCCEEDED could also answer 404 minutes later. *Design:* a 404 for a withdrawal the provider has already accepted never fails it and never resubmits it; it is checked again in 30 s, and only after `REVIEW_AFTER_MINUTES` is it flagged `UNKNOWN_AFTER_SUCCESS` (transitions W16 to W19 in `state-machines.md`). No curated excerpt was kept for this one; the behaviour is reproduced by the fake payout server in `withdrawal-sync.handler.int.spec.ts`.

Status vocabulary: `ACCEPTED → PROCESSING → SUCCEEDED | FAILED(INVALID_IBAN)`, `SUCCEEDED → RETURNED(ACCOUNT_CLOSED)`.

## Open questions

| # | Question | Status |
|---|---|---|
| 1 | The settlement CSV format | Answered: PSP-12 |
| 2 | The exact PSP minimum | Answered (*v2*): 10,000 rial, PSP-02 |
| 3 | The exact reversal window, and what verify returns after REVERSED | Open. The design verifies within seconds of seeing PAID and alerts after 2 minutes, so the exact window does not change it |
| 4 | Does INIT ever expire? | Open. Not seen in ~95 simulated minutes; we expire deposits ourselves after 24 hours (ADR-011) |
| 5 | Does a resubmit after a final status create a second transfer? | Answered (*v2*): no, PAY-02 |
| 6 | After a 503, is an immediate GET 404 final? | Answered for default mode (*v2*): 12 of 12 stayed 404, PAY-03. Hostile mode can answer 404 for a transfer that exists (PAY-14), which the design already tolerates |
| 7 | The latest SUCCEEDED → RETURNED, and whether stuck transfers finish | Partly answered: returns seen up to 180 s after success; one transfer in the v2 round took 7 minutes to settle. Successful withdrawals are watched for 24 hours |
| 8 | Does webhook delivery give up, and when? | Open. Not needed: a lost webhook is covered by polling |

## Changelog

- **v1** (2026-11-02): first probe, PSP-01 to PSP-11 and PAY-01 to PAY-13.
- **v1.1** (2026-11-05): PSP-12, the settlement file, for the reconciliation bonus.
- **v2** (2026-11-06): exact PSP minimum; de-duplication after a final status; 404 after a 503 in default mode; PAY-14 from the hostile chaos runs. None of these required a code change; they confirm decisions that were already in place.
