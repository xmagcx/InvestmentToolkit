# Universe Ingestion Specification

## Purpose

Python script that parses CSV text of investment candidates, normalizes tickers, and writes rows into the `universe_candidate` table. Handles the source-field ambiguity where `source` may encode both `asset_class` and `source` or `source` alone.

## Requirements

### Requirement: CSV Parsing with Header Validation

The system SHALL parse CSV text with the exact header `ticker,name,source` (3 comma-separated columns). The parser SHALL reject CSVs with missing, extra, or misspelled headers with a clear error message.

#### Scenario: Valid 3-column CSV parsed

- GIVEN CSV text with header `ticker,name,source` and 2 data rows
- WHEN the parser processes the CSV
- THEN 2 candidate records are produced with correct field values

#### Scenario: Wrong header rejected

- GIVEN CSV text with header `sym,company,broker`
- WHEN the parser processes the CSV
- THEN the parser returns an error indicating header mismatch
- AND no rows are written to the database

#### Scenario: Empty file handled

- GIVEN CSV text containing only the header line (no data rows)
- WHEN the parser processes the CSV
- THEN the parser returns success with 0 records inserted

### Requirement: Source Field Dual-Format Handling

The system SHALL parse the `source` field in two formats: bare source (e.g. `RACIONAL`) or `asset_class,source` (e.g. `EQUITY,RACIONAL`). When only a source is present, `asset_class` SHALL be set to NULL. When both are present, `asset_class` SHALL be set to the first segment and `source` to the second. The parser SHALL default `asset_class` to `EQUITY` when absent from the CSV row.

#### Scenario: Source only — no asset_class

- GIVEN a CSV row with source value `RACIONAL`
- WHEN the parser processes the row
- THEN `asset_class` is NULL and `source` is `RACIONAL`

#### Scenario: asset_class + source combined

- GIVEN a CSV row with source value `EQUITY,RACIONAL`
- WHEN the parser processes the row
- THEN `asset_class` is `EQUITY` and `source` is `RACIONAL`

### Requirement: Ticker Normalization

The system SHALL normalize every ticker via `ticker_aliases.normalize_ticker` before inserting into `universe_candidate`.

#### Scenario: Ticker normalized before insert

- GIVEN a CSV row with ticker `PSU.U.TO`
- WHEN the parser processes the row
- THEN the normalized form (e.g. `PSU-U.TO`) is stored in the DB

### Requirement: Duplicate Ticker Re-upload Idempotency

The system SHALL handle duplicate tickers on re-upload gracefully. If a ticker already exists, the parser SHALL skip the duplicate and report it, not fail the entire upload.

#### Scenario: Re-upload with existing tickers

- GIVEN `universe_candidate` contains `AAPL` and `MSFT`
- WHEN a CSV with `AAPL` and `GOOG` is uploaded
- THEN `GOOG` is inserted and `AAPL` is skipped
- AND the response reports 1 inserted, 1 skipped

### Requirement: Invalid Ticker Handling

The system SHALL reject rows where the ticker field is empty or whitespace-only. Invalid rows SHALL be reported in the error summary without aborting valid rows.

#### Scenario: Mixed valid and invalid rows

- GIVEN a CSV with rows: ticker=`AAPL`, ticker=`  `, ticker=`MSFT`
- WHEN the parser processes the CSV
- THEN `AAPL` and `MSFT` are inserted
- AND the whitespace ticker is reported as rejected
