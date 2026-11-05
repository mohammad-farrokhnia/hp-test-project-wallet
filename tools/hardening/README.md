# Hardening tools

Scripts that attack a running stack (`docker compose up -d --build --wait`). They are not part of `npm test`.

| Script | What it does | Pass means |
|---|---|---|
| `fuzz.mjs` | About 220 wrong or hostile requests: bad JSON, wrong types, overflow amounts, injection strings, oversized and over-nested bodies, bad signatures, wrong methods, idempotency-key abuse | no 5xx, nothing accepted that must be refused, idempotency answers correct |
| `chaos.mjs A..F` | Kills or restarts the API, workers, Postgres, RabbitMQ and the simulator under load; sends forged and out-of-order webhooks and callbacks | one deposit/withdrawal per key, nothing credited twice, ledger invariants hold, everything reaches a final state, dead-letter queue empty |

```bash
node tools/hardening/fuzz.mjs
node tools/hardening/chaos.mjs A B C D E F     # about 20 minutes
```

`chaos.mjs` recreates the simulator in the mode a scenario needs (`SIM_CHAOS`), so it needs the default compose project name (`wallet`).
