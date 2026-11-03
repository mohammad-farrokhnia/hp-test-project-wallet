# ADR-013: Stack: NestJS 11 with TypeORM and explicit SQL on money paths


## Context
The brief requires Node.js, TypeScript, NestJS and PostgreSQL. NestJS 12 shipped in August 2026: ESM-only, with Vitest and oxlint as new defaults. The developer must explain every line live.

## Options
| Option | For | Against |
|---|---|---|
| NestJS 12 (ESM) | Newest | Two months old; ESM friction with TypeORM CLI and test tooling inside a 4-day window |
| **NestJS 11 (CommonJS)** | Mature, documented, Jest by default | A major version behind |
| Prisma | Great types | Awkward row locking and interactive transactions |
| Kysely / raw `pg` | SQL is visible | Less familiar in NestJS projects; migrations by hand |
| **TypeORM (DataSource + migrations), explicit SQL on money paths** | NestJS standard; versioned migrations; `FOR UPDATE` support | Its `save()` hides read-modify-write |

## Decision
NestJS 11 on Node 22 LTS. TypeORM for the DataSource and versioned migrations; never `synchronize`. Repositories use the query builder or raw SQL for every money path, with explicit `FOR UPDATE`, and never call `save()` there (a lint rule flags it). Jest for unit and integration tests.

## Consequences
**Good**
- Conventional code an evaluator recognises; the SQL that matters is readable in review.

**Cost**
- TypeORM's entity features are mostly unused.
- A future upgrade to NestJS 12.
