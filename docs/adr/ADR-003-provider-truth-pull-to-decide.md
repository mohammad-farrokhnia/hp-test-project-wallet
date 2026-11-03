# ADR-003: Provider truth: pushes are hints, pulls decide, never fail on silence

- **Related:** provider-notes.md (PSP-04..10, PAY-02..13) · state-machines.md · Ambiguity #1

## Context

The probe showed both providers misbehave. PSP callbacks are unsigned, missing for ~15 % of payments, duplicated, sometimes say NOK for a paid payment, and sometimes carry a forged ×10 amount. Payout returns 503 or times out on requests that did create the transfer, and sends forged FAILED webhooks for transfers that succeeded. Trusting any of these loses or doubles money.

## Options


| Option                                                                                                  | For                                                                   | Against                                                                     |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Trust callbacks and webhooks                                                                            | Fewest calls, lowest latency                                          | Forged or lying pushes move money; lost pushes leave records stuck          |
| Treat timeout / 503 as failure                                                                          | Every request ends quickly                                            | Releases funds for transfers that were paid: a double payout (Ambiguity #1) |
| **Record pushes, decide only on our own GET / verify; keep money frozen until an answer is definitive** | Immune to forged, lying, duplicated and lost pushes; never pays twice | Extra calls; money frozen during outages                                    |




## Decision

A callback or webhook is stored in `inbound_events` and only schedules a sync. Statuses and money change only on what our own `GET` or `verify` returns. Webhooks also need a valid HMAC over the raw body, or they get 401. 503s, timeouts and connection resets are AMBIGUOUS and resolved by lookup, or by resubmitting the same requestId. After 30 minutes without an answer a record is flagged for review, and its money stays frozen.

## Consequences

**Good**

- No simulator trick from the probe can move money.
- Withdrawals are never paid twice by our own decision.
- The same rule covers both providers, so it's one idea to explain.

**Cost**

- One extra provider call per push.
- During a provider outage, user money stays frozen for as long as it lasts.
- A manual review queue someone must watch.

