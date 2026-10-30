# Schema migrations and database backups

Applies to `investment_screener/backend/data/domain_model.sqlite` (the sole source of truth for
holdings, accounts, targets and thesis data). `intelligence.sqlite` still uses its own
`py_services/intelligence/migrations/`; it shares only the backup tooling for now.

## Why this exists

Before this change the schema was defined in **seven places**: `db_client.py` plus six
TypeScript repositories, each with its own `CREATE TABLE IF NOT EXISTS`. Four TypeScript
repositories declared their own, narrower `investment` table. Because `IF NOT EXISTS` never
compares columns, whichever code ran first on an empty file decided the shape for good. The
databases are gitignored and run in WAL mode, so there was also no recoverable copy of the data.

## The rules

1. **Python is the only code that creates or alters tables.** `schema_migrator.py` applies the
   numbered files in `investment_screener/backend/schema/domain_model/`.
2. **Node never touches DDL.** Each TypeScript repository calls `ensureSchemaReady()`
   (`src/utils/schemaVersion.ts`), which checks `PRAGMA user_version`:

   | Database state | What happens |
   |---|---|
   | Version matches the newest migration file | proceed |
   | New or empty file | the Python migrator is asked to build it (nothing to lose) |
   | Populated file that is **behind** | refused, with the command to run |
   | File **ahead** of this checkout | refused: update the code first |
3. **Applied migrations are immutable.** Each is recorded in `schema_migrations` with a SHA-256
   checksum; editing one later fails startup. Fix forward with a new file.
4. **A populated database is backed up before any pending migration**, and the migration runs in
   one transaction, so a failure rolls back completely.

## Adding a schema change

1. Add the next file: `investment_screener/backend/schema/domain_model/0002_<snake_case>.sql`.
   Plain SQL, no `BEGIN`/`COMMIT` (the runner wraps it). Numbers must be contiguous.
   **The first line must be a comment that says what changes and why** (at least 15 characters;
   the runner refuses a file without one). Further comment lines are encouraged:

   ```sql
   -- 0002_valuation_model: add valuation_model to sub_strategy so the DCF skill can choose the
   -- landlord, neocloud or operating-company method for each holding.
   -- Types: operating, colocation_landlord, neocloud_gpu, hybrid_sotp.
   ALTER TABLE sub_strategy ADD COLUMN valuation_model TEXT;
   ```
2. Run `python3 investment_screener/backend/py_services/domain_model/schema_migrator.py --status`
   to see it pending, then the same command without `--status` to apply it.
3. Add or update tests. Do **not** touch `0001_baseline.sql` or any applied migration.
4. If a migration rebuilds a table, it must run with foreign keys off, which SQLite cannot
   change inside a transaction. Handle that case in the runner before writing such a migration.

`run_investment_toolkit.py` runs the migrator on every launch, after the backend build and before
the servers start.

## Version history

The `schema_migrations` table is the database's own change log: one row per migration, written in
the same transaction that applies it.

| Column | Meaning |
|---|---|
| `version`, `name` | the file, e.g. `2`, `valuation_model` |
| `description` | the plain-English first line of the file |
| `kind` | `applied` (ran the SQL) or `adopted` (an older database stamped as the baseline) |
| `applied_at`, `applied_by` | UTC time and the OS user that ran it |
| `git_commit` | short commit of the code that ran it (best effort) |
| `duration_ms` | how long it took |
| `tables_touched` | detected from the SQL (`CREATE`/`ALTER`/`DROP TABLE`, `CREATE INDEX ... ON`, `INSERT`/`UPDATE`/`DELETE`) |
| `backup_file` | the pre-migration backup that protects it, if one was taken |
| `checksum` | SHA-256 of the file; a later edit is refused |

```bash
python3 investment_screener/backend/py_services/domain_model/schema_migrator.py --status            # version + pending, with descriptions
python3 investment_screener/backend/py_services/domain_model/schema_migrator.py --history           # the recorded history
python3 investment_screener/backend/py_services/domain_model/schema_migrator.py --history --json    # machine-readable
```

The same data is plain SQL: `SELECT version, name, description, applied_at FROM schema_migrations`.

## Databases that existed before the migrator

A file with tables but no `schema_migrations` ledger is *adopted*: missing tables are created,
the three retired late columns are added, and the result is compared with `0001_baseline.sql`
(columns, types, defaults, foreign keys, indexes). If they match it is stamped as version 1. If
not, adoption is **refused and the file is left exactly as found**, with the differences listed.
This was dry-run against a copy of the live database: all 20 tables kept identical row counts.

An extra object **is** tolerated when it belongs to a migration the adopter has not applied yet
(ADR-039). All three conditions must hold:

1. a migration numbered after the baseline declares it;
2. that migration creates it with `CREATE ... IF NOT EXISTS`, so applying it later is a no-op;
3. the live shape — columns, types, defaults, foreign keys and index attachment — is exactly
   what that migration builds.

The kept object is listed in the `adopted` row's `tables_touched`. This is how a table built by
hand on a branch that pre-dated the migrator (`universe_candidate`, ADR-032 on
`feat/opportunity-screener-research`) survives adoption without weakening the drift check: any
other difference still refuses the file.

## Backups

`py_services/domain_model/db_backup.py` uses SQLite's online backup API. Copying only the
`.sqlite` file silently loses data still sitting in the `-wal` file; this does not.

| When | Label | Kept |
|---|---|---|
| Every launch of `run_investment_toolkit.py` | none | newest 14 per database |
| Before a pending migration on a populated file | `pre-migration-NNNN` | counted in the same 14 |
| Before a restore | `pre-restore` | counted in the same 14 |

Files go to `investment_screener/backend/data/backups/` (gitignored), one self-contained
`.sqlite` each, and every backup passes `PRAGMA integrity_check` before it is kept.

```bash
python3 investment_screener/backend/py_services/domain_model/db_backup.py backup  --db domain_model
python3 investment_screener/backend/py_services/domain_model/db_backup.py list    --db domain_model
python3 investment_screener/backend/py_services/domain_model/db_backup.py verify  <backup-file>
# Restore: STOP the backend first. A safety copy of the current file is taken automatically.
python3 investment_screener/backend/py_services/domain_model/db_backup.py restore <backup-file> --db domain_model --yes
```

Backups live on the same disk as the database, so they protect against bad writes and bad
migrations, not against losing the machine. Copy `backups/` somewhere else for that.

## Known gaps (not addressed here)

* `intelligence.sqlite` migrations are separate and not yet unified with this runner.
* The reference file `plugins/toolkit-manager/.apm/skills/managing-the-toolkit/references/data-architecture/sql/03_domain_data_model_schema.sql`
  is a historical design document, superseded by the migration files.
* Broker sync does not yet trigger its own backup; the launch-time backup is the safety net.
