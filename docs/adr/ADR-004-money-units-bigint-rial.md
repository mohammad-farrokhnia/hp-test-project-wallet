# ADR-004: Money as BIGINT minor units, with IRR stored as rial

- **Status:** Accepted · 2026-11-03
- **Related:** design.md §2 · data-model.md conventions · PSP-01, PAY-01 · spec guarantee 3

## Context
The brief bans floats. The API speaks toman (integer) and USDT (up to 6 decimals). The probe showed the PSP charges in rial (1,000,000 is shown as 100,000 toman) and the payout service takes `IRR`. "Not one rial may be lost."

## Options
| Option | For | Against |
|---|---|---|
| Floating point | — | Forbidden; 0.1 + 0.2 ≠ 0.3 |
| NUMERIC + a decimal library | Exact; arbitrary precision | Slower; mixes scales; a library in every calculation |
| Integer toman | Matches the API | Can't represent a rial; conversion at the riskiest boundary (payout) |
| **Integer rial and micro-USDT in BIGINT, behind a `Money` value object** | Exact; matches both providers; fast native arithmetic | ×10 at the API edge |

## Decision
Every amount is a `bigint` in minor units: rial for IRR, 10⁻⁶ for USDT. The `Money` value object parses strings only (never `Number()`) and formats back to API strings. A lint rule bans `parseFloat` and `Number()` on amounts. The payout adapter sends IRR integers and USDT decimal strings.

## Consequences
**Good**
- Exact arithmetic, and no unit conversion at the payout boundary.
- An odd-rial amount from the gateway is credited in full.

**Cost**
- ×10 conversion at the API edge, tested exhaustively.
- `bigint` can't go into JSON directly, so every response formats explicitly.
- An odd-rial balance would display a toman decimal; this happens only in a flagged anomaly path.

**Revisit when** a currency needs more than 18 significant digits, which no supported currency does.
