# Hardening tools

Scripts that attack a running stack (`docker compose up -d --build --wait`). They are not part of `npm test`.

| Script | What it does | Pass means |
|---|---|---|
| `fuzz.mjs` | About 220 wrong or hostile requests: bad JSON, wrong types, overflow amounts, injection strings, oversized and over-nested bodies, bad signatures, wrong methods, idempotency-key abuse | no 5xx, nothing accepted that must be refused, idempotency answers correct |
| `chaos.mjs A..J` | Kills or restarts the API, workers, Postgres, RabbitMQ and the simulator under load; sends forged and out-of-order webhooks and callbacks | one deposit/withdrawal per key, nothing credited twice, ledger invariants hold, everything reaches a final state, dead-letter queue empty |
| `bench.mjs [seconds] [clients]` | Closed-loop load: adjustments of existing users (one system-account row), withdrawals of distinct users, withdrawals of one hot user, then times the drain of the outbox and the payout pipeline | prints req/s and p50/p95/p99 per phase; read as ratios (see `docs/scalability.md`) |
| `relay-bench.mjs [rows]` | Stops the workers, builds an outbox backlog, then starts one worker and the second | prints outbox rows published per second with one relay and with two |
| `capacity.mjs [scenario ...] [--options]` | Open-loop capacity test: for each scenario (reads, withdraw, transfer, hot, adjust, deposit, mixed) the request rate grows step by step until the p95 SLO, the error budget or the achieved rate fails; it samples container CPU and PostgreSQL lock waits on every step, then checks the invariants | prints the highest rate each scenario sustains within the SLO, and why the next step failed |
| `publish-bench.mjs [messages]` | One connection publishing to a throwaway quorum queue, confirm by confirm and with 10 / 100 / 1,000 in flight | prints msg/s for each; the relay's ceiling comes from the first line |

```bash
node tools/hardening/fuzz.mjs
node tools/hardening/chaos.mjs A B C D E F     # about 20 minutes
SIM_CHAOS=off docker compose up -d --wait      # for the three benchmarks below, so provider chaos does not blur them
node tools/hardening/bench.mjs 15 32
node tools/hardening/relay-bench.mjs 6000
node tools/hardening/publish-bench.mjs 3000
node tools/hardening/capacity.mjs --out=capacity.json      # about 15 to 25 minutes for every scenario
node tools/hardening/capacity.mjs hot --start=25 --factor=1.25 --duration=30   # one scenario, finer steps
```

`chaos.mjs` recreates the simulator in the mode a scenario needs (`SIM_CHAOS`), so it needs the default compose project name (`wallet`).
