# Universe API Specification

## Purpose

Express CRUD routes behind `/api/universe` providing upload, list, and delete operations. The router acts as a thin bridge, shelling out to the Python ingestion script for write operations and querying SQLite directly for reads.

## Requirements

### Requirement: POST /api/universe/upload Accepts CSV Text

The system SHALL expose `POST /api/universe/upload` accepting a JSON body with a `csv` field containing raw CSV text. The route SHALL NOT use multer or any file upload middleware. The route SHALL invoke `ingest_universe_csv.py` via shell and return the parse/write result.

#### Scenario: Successful upload returns summary

- GIVEN valid CSV text in `{ "csv": "ticker,name,source\n..." }`
- WHEN `POST /api/universe/upload` is called
- THEN the response is `200 OK` with `{ inserted: N, skipped: M, errors: [] }`

#### Scenario: Malformed CSV returns 400

- GIVEN CSV text with wrong headers in `{ "csv": "bad,headers\n..." }`
- WHEN `POST /api/universe/upload` is called
- THEN the response is `400 Bad Request` with error detail

#### Scenario: Missing body returns 400

- GIVEN no JSON body or `{}` without `csv` field
- WHEN `POST /api/universe/upload` is called
- THEN the response is `400 Bad Request`

### Requirement: GET /api/universe Lists All Candidates

The system SHALL expose `GET /api/universe` returning all rows from `universe_candidate` ordered by `added_at DESC`. Response SHALL be `200 OK` with a JSON array of candidate objects.

#### Scenario: List returns all candidates

- GIVEN `universe_candidate` contains 5 rows
- WHEN `GET /api/universe` is called
- THEN the response is `200 OK` with 5 candidate objects ordered newest first

#### Scenario: List returns empty array when no candidates

- GIVEN `universe_candidate` is empty
- WHEN `GET /api/universe` is called
- THEN the response is `200 OK` with `[]`

### Requirement: DELETE /api/universe/:ticker Removes One Candidate

The system SHALL expose `DELETE /api/universe/:ticker` removing exactly the matching row. The route SHALL normalize the ticker parameter before deletion.

#### Scenario: Successful delete

- GIVEN `universe_candidate` contains ticker `AAPL`
- WHEN `DELETE /api/universe/AAPL` is called
- THEN the response is `200 OK` and the row is removed

#### Scenario: Delete nonexistent ticker returns 404

- GIVEN `universe_candidate` does not contain `ZZZZ`
- WHEN `DELETE /api/universe/ZZZZ` is called
- THEN the response is `404 Not Found`
