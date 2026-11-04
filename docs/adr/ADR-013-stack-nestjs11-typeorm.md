# ADR-013: Stack: NestJS 11 with TypeORM, and typed explicit SQL (Kysely) on money paths


## Context
The brief requires Node.js, TypeScript, NestJS and PostgreSQL. NestJS 12 shipped in August 2026: ESM-only, with Vitest and oxlint as new defaults. The developer must explain every line live.

## Options
| Option | For | Against |
|---|---|---|
| NestJS 12 (ESM) | Newest | Two months old; ESM friction with TypeORM CLI and test tooling inside a 4-day window |
| **NestJS 11 (CommonJS)** | Mature, documented, Jest by default | A major version behind |
| Prisma | Great types | Awkward row locking and interactive transactions |
| Raw SQL strings through TypeORM | SQL is visible | Result types are casts: a column typo or a wrong result shape fails only at runtime |
| **Kysely (query builder only)** | SQL-shaped and visible; tables, columns and results typed from the live schema; `FOR UPDATE` | Less familiar in NestJS projects; one more dependency; 0.29+ is ESM-only |
| **TypeORM (DataSource + migrations), explicit SQL on money paths** | NestJS standard; versioned migrations; `FOR UPDATE` support | Its `save()` hides read-modify-write |

## Decision
NestJS 11 on Node 22 LTS. TypeORM for the DataSource and versioned migrations; never `synchronize`. Repositories use the query builder or raw SQL for every money path, with explicit `FOR UPDATE`, and never call `save()` there (a lint rule flags it).

Repository SQL is written with **Kysely as a typed query builder only**. `db(tx)` (`src/database/kysely.ts`) runs Kysely's compiled SQL on the QueryRunner of the open TypeORM transaction, so `TransactionRunner` still owns begin/commit, the lock and statement timeouts and deadlock retries; Kysely's own `transaction()` is refused. Table types live in `src/database/db.types.ts`, generated from the migrated schema by `npm run db:types` (kysely-codegen) and committed. Statements a builder obscures (ordered `unnest ... WITH ORDINALITY` inserts, CTEs) use Kysely's `sql` template, which keeps parameters bound. Kysely is pinned to 0.28.x: 0.29 is ESM-only, and Jest on Node 22 cannot load it from this CommonJS project. Jest for unit and integration tests.

## Consequences
**Good**
- Conventional code an evaluator recognises; the SQL that matters is readable in review.
- A typo in a table or column name, or a wrong result shape, is a compile error, not a runtime surprise.

**Cost**
- TypeORM's entity features are mostly unused.
- A future upgrade to NestJS 12.
- `db.types.ts` must be regenerated after every migration (`npm run db:types`); a stale file compiles against the old schema.
- Moving to Kysely 0.29+ waits on the same ESM move as NestJS 12.
