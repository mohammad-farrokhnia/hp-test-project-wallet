# Incident analysis: negative USDT balances after a deploy

**Report.** At 02:10, after a deploy, 17 users' USDT balances went negative (4,210 USDT in total). Each had at least two withdrawals in the previous 10 minutes. Redis CPU hit 100 % and the withdrawal service scaled from 2 to 6 instances. Ledger sums per user are correct; stored balances do not match them.

**Reading.** The postings are right and the balance column is wrong, so the balance was not derived from the postings in the same atomic step. Only users with two close withdrawals are affected, so two operations on one wallet interleaved. Redis was the coordinator, and it was saturated.

## Likely causes and the data to confirm each

| # | Cause | Data that confirms it |
|---|---|---|
| 1 | **The Redis lock stopped excluding.** Under 100 % CPU, lock calls exceeded the TTL or timed out; the code continued without the lock, or a lock expired mid-operation. Two instances read the same balance, both passed the check, and both wrote `balance = old − amount` | Lock latency and timeout logs; lock TTL versus p99 withdrawal duration; Redis `SLOWLOG` and `INFO commandstats`; per-user timelines showing two withdrawals overlapping on different instances |
| 2 | **The deploy changed coordination.** Old and new versions ran side by side with different lock keys or TTLs, or the new code read the balance from a Redis cache and wrote it back | The deploy diff; which version handled each affected withdrawal; whether the first bad write follows the first new pod |
| 3 | **Retries applied the decrement twice.** Redis timeouts failed handlers after the database write; the job was redelivered; the journal insert was de-duplicated but the balance update was not in the same transaction | Broker redelivery counts; balance updates versus journals per withdrawal |
| 4 | **The scale-out fed the CPU spike.** Six instances retrying locks in tight loops | Redis connections and command rate per instance; autoscaler events |

## First 30 minutes

1. **Stop the damage.** Pause USDT withdrawals (flag or workers to zero); block the 17 users; roll back the deploy if the timing matches.
2. **Keep the evidence.** Snapshot Redis `INFO`, `SLOWLOG` and lock keys, logs, the deploy manifest, broker state, and the database, before anyone edits a balance.
3. **Measure the real loss.** Recompute every balance from the ledger for all users, not only the 17. Compare the payout provider's records with our withdrawals: if every transfer that left is in the ledger, no money is lost and only the stored balance is wrong; if more left, involve finance.
4. **Communicate.** Incident channel; support and finance told which users are affected.
5. **Do not fix balances yet.** Rebuild them from the ledger after the cause is fixed and writes are stopped, in one audited transaction per user.

## Is this design immune?

To this failure, yes, by construction:

- **No Redis.** The lock is the PostgreSQL row lock on the user's accounts, held by the same transaction that checks and writes the balance. It cannot expire while held, and it does not care how many instances or versions run.
- **Balance and postings commit together**, inside `LedgerService.post`, the only writer of money. A redelivered job hits `UNIQUE (kind, ref_type, ref_id)` and changes nothing.
- **The database refuses a negative balance** with a CHECK constraint, even if the code is wrong.
- **Drift is detectable.** `GET /internal/invariants` checks that every balance equals the sum of its postings.

Not immune to contention: a hot wallet's requests queue on its row lock and fail with 503 after 3 s, never with wrong money. The gap I would close first: the invariant check runs only on demand; in production it should run every few minutes and alert.
