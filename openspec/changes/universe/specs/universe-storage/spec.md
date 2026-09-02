# Universe Storage Specification

## Purpose

Persistent storage layer for the curated investment candidate universe. Provides a dedicated `universe_candidate` table in `domain_model.sqlite` with DDL self-heal via `SCHEMA_EVOLUTIONS`.

## Requirements

### Requirement: Universe Candidate Table Exists

The system SHALL create a `universe_candidate` table in `domain_model.sqlite` via DDL evolution in `SCHEMA_EVOLUTIONS`. The table SHALL have columns: `ticker TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `source TEXT NOT NULL`, `asset_class TEXT` (nullable), `added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`. The DDL SHALL be self-healing — if the table is missing on any DB init, it gets recreated.

#### Scenario: Table created on fresh DB init

- GIVEN `domain_model.sqlite` does not contain `universe_candidate`
- WHEN `db_client.py` initializes the database
- THEN `universe_candidate` table exists with correct columns and types
- AND the evolution record is written to `schema_evolutions`

#### Scenario: Table survives re-init

- GIVEN `universe_candidate` table already exists with rows
- WHEN `db_client.py` re-runs initialization
- THEN existing rows are preserved unchanged
- AND no duplicate DDL is applied

### Requirement: Ticker Uniqueness Enforced

The system SHALL enforce `ticker TEXT PRIMARY KEY` on `universe_candidate`. Inserting a duplicate ticker SHALL fail at the DB level, not silently overwrite.

#### Scenario: Duplicate ticker insert rejected

- GIVEN `universe_candidate` contains ticker `AAPL`
- WHEN an insert for ticker `AAPL` is attempted
- THEN the DB rejects the insert with a constraint violation error
