# ADR-012: Daily limit as a reserved counter per Tehran calendar day

- **Related:**  Ambiguity #2

## Context
Each user may withdraw at most 200,000,000 toman per day, even under concurrent requests. The brief leaves open which day, whether failed withdrawals count, and how USDT converts (Ambiguity #2).

## Options
| Option | For | Against |
|---|---|---|
| SUM the day's withdrawals under the lock | No extra table | A growing query inside the hot transaction |
| Rolling 24-hour window | No midnight edge | Harder to explain to users; needs a time-ordered sum |
| UTC day | Simple | Resets at 03:30 Tehran time, confusing users |
| **Counter row per user and Tehran calendar day, reserved at request** | O(1) check; the cap is a database CHECK; concurrency-safe under the same lock order | Around midnight a user can use two days' caps back to back |

## Decision
`withdrawal_daily_usage (user_id, day)` holds `used_rial` and `cap_rial` with `CHECK (used ≤ cap)`. The day is computed from the database clock in Asia/Tehran (UTC+3:30, no daylight saving). The amount is reserved at request (pending and processing withdrawals count), released when a withdrawal fails or is cancelled before money left, and kept on success and on return. USDT (bonus) counts toward the same toman cap at a reference rate, rounded up, and the fee is not counted: `limit_amount_rial = ceil(amount_micro × rate_rial_per_usdt / 1,000,000)`, so even a dust amount counts at least 1 rial. The rate is `USDT_IRT_REFERENCE_RATE` (toman per 1 USDT, default 100,000, held as rial) and is saved on the withdrawal row (`limit_rate_rial_per_usdt`) together with the amount it produced. Releasing a failed withdrawal gives back that stored amount, so a rate change never mis-releases it. An amount whose counted value exceeds the cap is refused whole (`DAILY_LIMIT_EXCEEDED`).

## Consequences
**Good**
- One indexed row per user per day; the database refuses a breach.

**Cost**
- The midnight edge allows up to two caps within minutes.
- USDT needs a configured reference rate, and the operator must keep it near the market: a stale rate lets USDT through the cap too cheaply or too dearly. It is the only reason the cap is not exact for USDT.

