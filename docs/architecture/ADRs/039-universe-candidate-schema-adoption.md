# ADR-039: A branch-built table enters the schema as a guarded migration, and adoption tolerates it

Date: 2026-10-30
Status: Accepted

## Problem

`investment_screener/backend/data/domain_model.sqlite` failed to open on `main`:

```
existing database does not match 0001_baseline.sql; refusing to adopt it
(nothing was changed): unexpected table or index set: universe_candidate
```

The table came from `feat/opportunity-screener-research` (ADR-032 on that branch, 2026-09-02),
which created `universe_candidate` by hand in `db_client.py`. That branch pre-dates the schema
migrator (2026-09-30) and carries no `schema/domain_model/` directory, so `main`'s
`0001_baseline.sql` never learned about the table. The file, opened on the branch, therefore has
`user_version = 0`, no `schema_migrations` ledger, and one object the baseline does not declare.

Adoption refused it for good reason: the migrator cannot tell an intentional branch table from
drift. But the 2,577 rows in `universe_candidate` are real curated tickers and names, and the
file is the sole source of truth. Deleting the table was not an option.

## Decision

1. **`universe_candidate` is schema-owned.** Migration
   `0012_universe_candidate.sql` declares it in the shape the branch builds. It is declared as
   `CREATE TABLE IF NOT EXISTS` so that applying it over a file the branch already built is a
   no-op, not a failure. The feature branch must delete its `CREATE TABLE IF NOT EXISTS
   universe_candidate` block from `db_client.py` when it merges; comments in both places say so.
2. **Adoption tolerates an extra object only under three conditions**, all enforced in
   `schema_migrator._adoption_tolerances`:
   - a migration **after the baseline** declares that object;
   - that migration's `CREATE` is guarded with `IF NOT EXISTS`, so re-running it over the
     existing object cannot fail;
   - the live shape (columns, types, defaults, foreign keys, and index attachment) is exactly
     what that migration builds **at its own version**.
   Anything else still refuses adoption with the original message.
3. **Adopted objects are recorded.** The `adopted` row in `schema_migrations` lists them in
   `tables_touched`, so the ledger shows that `universe_candidate` came from the file rather
   than from applying migration 12.
4. **The baseline stays untouched.** The fix is a new migration plus a narrower adoption rule;
   `0001_baseline.sql` and every applied migration keep their checksums.

Refusal remains safe: the adoption transaction rolls back, so a rejected file is left byte-identical.

## Consequences

- The live file opens on `main` again: adoption keeps `universe_candidate` and its rows, then
  applies migrations 2–12 (the file was also six migrations behind `main`).
- `main` now requires `user_version = 12`. A checkout without migration 12 refuses a database
  that already has it, as with any ahead-of-code file.
- A branch that hand-builds a table can still reach `main`, but only through a guarded migration
  with a matching shape. Shape drift, an undeclared object, or an unguarded `CREATE` is still a
  hard refusal, which is what keeps adoption from becoming a rubber stamp.
- `schemaVersion.ts` derives the required version from the newest migration file, so the Node
  gate follows without a code change.

## Alternatives rejected

- **Delete `universe_candidate` from the live file.** Destroys 2,577 curated rows and the record
  of which tickers were considered.
- **Add the table to `0001_baseline.sql`.** Changes an applied migration's checksum and forces
  every existing database to migrate instead of adopting.
- **Accept any extra table during adoption.** Turns a drift check into a no-op; a typo or a stale
  experiment would silently become permanent schema.
- **Port the opportunity-screener feature to `main` first.** That branch is 1,786 inserted lines
  across routes, services and UI; the schema conflict is independent of the feature and blocks
  every `main` launch today.
