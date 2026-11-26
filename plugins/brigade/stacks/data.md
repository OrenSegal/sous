# Stack: data services (SQL, migrations, pipelines, scrapers, analytics)

## Verify ladder

| Rung | Typical command | Proves |
|---|---|---|
| fast | SQL lint (`sqlfluff`), Python lint (`ruff check`), schema or model compile (`dbt compile`) | it parses |
| verify | unit tests on transforms, data tests (`dbt test`, Great Expectations, pytest fixtures), migration applied to an empty local database | logic and schema |
| runtime | the migration or job run against a copy of real data, with row counts and a sample before and after | it works on the data that exists |

## Done means

- Migration applied to a fresh local database and to a copy of production shape, with the output read.
- A rollback or roll-forward plan written down before apply. Destructive steps (drop, truncate, type change) named and approved by a person.
- Row counts, nulls and duplicates checked before and after on the affected tables.
- Access rules (row-level security, grants) checked for every new table, view and function.
- Jobs are idempotent: running twice gives the same result.

## Review for

- Locks and long transactions on large tables. Index creation without `CONCURRENTLY` where the database supports it.
- Functions that run with elevated rights, and what input reaches them.
- Silent data loss: casts, truncation, timezone handling, encoding.
- Backfills that read or write everything at once.
- Scrapers: robots and terms, rate limits, retries with backoff, and a test fixture of a real page.

## Product and design checks

- A metric is a product decision. Write down what question it answers before adding it.
- Dashboards and reports say when the data was last updated and what it excludes.

## Traps

- Apply migrations by name, in order, through the project's tool. Never paste SQL into a production console.
- An empty table in a new environment may be correct (no users yet), not a broken writer. Check before fixing.
