# Scalability at 50× load

**The question.** Load grows 50×: 500 withdrawals per second and 2 million wallets, and one corporate wallet alone makes 200 withdrawals per second. Where is the first bottleneck, and what would I change? Analysis only; nothing below is implemented.

**Short answer.** The first bottleneck is not the corporate wallet but the **system accounts**: every settlement locks the single `PAYOUT_CLEARING` row of its currency, so all 500 settlements per second queue on one row, which on my machine handles about 100–120 transactions per second. The corporate wallet is the second, for the same reason and with a user-visible failure. The outbox relay is the third. All three come from the same property of the design, a row lock per account, which is also what makes it correct. The fixes keep the lock where correctness needs it (user balances) and remove it where it does not (system accounts).

## 1. What I measured

All numbers come from the scripts in `tools/hardening/`, run against the full compose stack (two API replicas, two workers, nginx, PostgreSQL 17, RabbitMQ 4) on one Windows 11 laptop with Docker Desktop: 12 CPUs and 7.9 GB for Docker, simulator in `off` mode, 32 closed-loop clients, 15 seconds per phase. Everything ran on one machine, so the absolute numbers are low; the ratios between them are what matters.

| Measurement | Result | What it exercises |
|---|---|---|
| Adjustments of existing users (`bench.mjs` phase 1) | **118 req/s**, p50 165 ms, p95 966 ms, p99 3,183 ms | Every request locks the one `OPS_ADJUSTMENTS` system row |
| Withdrawal requests, a different user each (phase 2) | **372 req/s**, p50 85 ms, p95 151 ms, p99 177 ms | User rows only: accounts, daily usage, outbox |
| Withdrawal requests, one hot user (phase 3) | **95 req/s**, p50 344 ms, p95 675 ms, p99 740 ms | Every request waits for the same account rows |
| Outbox drain after the load (phase 4) | 13,548 rows in 212 s, about **64 rows/s**, while the workers also processed the jobs | Relay throughput under real work |
| Payout submits while draining | about **84 withdrawals/s** | Submit jobs through two workers |
| Outbox relay alone (`relay-bench.mjs`) | **88 rows/s** with one relay, **149 rows/s** with two | Relay throughput without competing work |
| RabbitMQ publish with confirms (`publish-bench.mjs`) | **221 msg/s** one at a time; 1,089 with 10 in flight; **10,124** with 100; 21,280 with 1,000 | The broker is not the limit; waiting for each confirm is |

Two observations decide the analysis:

1. **A single hot row tops out at about 100–120 transactions per second**, whether it is a system account (phase 1) or a user's account (phase 3). Each transaction holds the row lock for a few milliseconds, and the queue behind it is strictly serial. Distinct rows scale until the API or the database runs out of CPU (phase 2).
2. **The relay is limited by its own loop**, which publishes one message and waits for its confirm before the next: about 220 messages per second per relay at best, measured lower with database work around it. The broker accepts 50 times more when confirms are pipelined.

## 2. What 50× asks of each part

One withdrawal, end to end, is about seven short transactions: the request; the submit job's claim and its outcome; two or three webhook intakes; one or two syncs, one of which books the settlement. It writes about five outbox rows: the submit job, one balance event for the freeze, the sync jobs triggered by webhooks, and one balance event for the settlement.

| Part | Needed at 500 withdrawals/s | Measured capacity | Verdict |
|---|---|---|---|
| `PAYOUT_CLEARING` row (every settlement) | 500 tx/s on **one row** | ~100–120 tx/s | **First bottleneck** |
| `FEE_REVENUE` row (every USDT settlement) | up to 500 tx/s on one row | ~100–120 tx/s | Same problem, for USDT |
| `PSP_CLEARING` row (every deposit credit) | the deposit rate, on one row | ~100–120 tx/s | Same problem, for deposits |
| The corporate wallet's account rows and daily-usage row | 200 tx/s on one user's rows | ~95 tx/s | **Second bottleneck**, user-visible |
| Outbox relay | ~2,500 rows/s | ~150 rows/s with two relays | **Third bottleneck** |
| Workers (submit and sync jobs) | ~3,000 jobs/s | ~84 submits/s with two workers | Scales by adding workers |
| PostgreSQL primary, overall | ~3,500 short write transactions/s and ~3,000 posting rows/s (about 260 million rows a day) | Not measured at this scale | Feasible on server hardware, with partitioning |
| 2 million wallets | up to 12 million account rows | — | Not a problem: one indexed row lookup per account |

### Why the system accounts come first

`LedgerService.post` locks every account in the journal, system accounts included, and updates their running balance. A user's withdrawal touches its own rows when it is requested, so requests from different users run in parallel (phase 2). The settlement is different: `WITHDRAWAL_SETTLE` moves money from the user's FROZEN to `PAYOUT_CLEARING`, so every settlement of every user locks that same row. At 500 per second the settlement syncs queue behind each other; past `lock_timeout` (3 s) they fail with `SERVICE_BUSY`, the job is retried, and money stays frozen longer than it should. Nothing is lost or doubled, because the sweeper picks up anything due, but the backlog grows without limit.

The failure is not visible at request time, which is why it is easy to miss: requests keep being accepted at the phase 2 rate while settlements fall further behind.

### Why the corporate wallet is next

200 withdrawals per second on one user is twice the measured ceiling for one user's rows (95 per second, p50 already 344 ms at 32 clients). Its requests wait on the account lock and then on the daily-usage row; past 3 seconds they fail with `SERVICE_BUSY`. This one is visible to the client immediately.

### Why the relay is third

The relay must move about five rows per withdrawal. Two relays move about 150 rows per second, enough for 30 withdrawals per second. Nothing is lost when it falls behind, because the rows wait in the table, but submits and balance events are delayed by as long as the backlog takes to drain.

## 3. What I would change, in order

### 1. Take the lock off the system accounts

System accounts may go negative by design, so no check depends on their balance at the moment of a transaction. Locking them buys nothing.

- **Change:** `LedgerService.post` appends postings for system accounts but neither locks them nor updates their running balance. Their balance is the sum of their postings, maintained by a periodic roll-up (`balance_as_of`, `rolled_up_to_posting_id`) or read from a view. User accounts keep the lock, the running balance and the CHECK.
- **Alternative with less change:** shard each system account into, say, 32 rows per currency, chosen by a hash of the journal's reference, and report the sum. This keeps the code path identical and multiplies the ceiling by the shard count.
- **What stays true:** every journal still sums to zero, the deferred trigger still checks it, and the invariant check compares system balances with their postings after each roll-up.

### 2. Split the corporate wallet into sub-wallets

- **Change:** the corporate user owns K sub-wallets (for example 8), each a normal set of accounts with its own lock. A withdrawal starts at a random sub-wallet and moves to the next if that one cannot cover it. A background job rebalances funds between sub-wallets with ordinary transfer journals. `GET /wallets` reports the sum.
- **Daily limit:** the corporate wallet's cap is either lifted (it is a business account with its own controls) or split across the sub-wallets' counters, each holding cap / K, with a rebalance of unused allowance.
- **Why not a bigger machine:** the limit is lock hold time on one row, not CPU. A faster disk and CPU shorten the hold time somewhat but cannot double the ceiling reliably.

### 3. Make the relay pipeline its confirms

- **Change:** publish the whole claimed batch, then wait for all confirms together, instead of one at a time. The broker measured 10,124 messages per second with 100 in flight. Relays already scale horizontally through `SKIP LOCKED`; four relays with pipelining cover the 2,500 rows per second with room to spare.
- **Fewer messages:** a webhook-triggered sync job can be skipped when one is already queued for the same withdrawal; on the simulator's duplicated webhooks (PAY-11) this halves the job volume.

### 4. Scale the workers and protect the database

- **Workers** are stateless: add replicas and raise the prefetch. Provider calls are the slow part, and they happen outside any transaction.
- **Connections:** at 10 per instance, many API and worker replicas exceed PostgreSQL's connection limit. Put PgBouncer in transaction mode in front of it; the code already keeps every transaction short and sets its timeouts per transaction, which is what transaction pooling needs.
- **Growth:** partition `postings`, `journals` and `outbox` by month (the outbox by day), so indexes stay small and old partitions can be detached instead of deleted. The history query uses `(user_id, id DESC)` and stays fast inside each partition.
- **Reads:** serve `GET /wallets/{id}/ledger` and dashboards from a read replica. Balance checks for withdrawals always stay on the primary, under the lock.

### 5. What I would not change

The correctness core stays: row locks on user accounts in one global order, the balance updated in the same transaction as its postings, CHECK constraints, the outbox, pull-to-decide for providers. Every change above removes contention where no invariant depends on it; none of them trades correctness for throughput.

## 4. How I would verify the changes

Rerun `bench.mjs` with a fourth phase that settles withdrawals at a fixed rate, and confirm that the settlement rate scales with workers instead of flattening at about 100 per second. Rerun `relay-bench.mjs` with pipelining and expect the rate to be limited by the database rather than by confirms. Throughout, `GET /internal/invariants` must stay green and `chaos.mjs` must pass unchanged.
