# Universe Maintainer UI Specification

## Purpose

React page allowing users to upload a CSV of investment candidates and view/manage the universe list. Provides file input, upload trigger, table display, and per-row delete.

## Requirements

### Requirement: UniversePage Route and Navigation Entry

The system SHALL register `UniversePage.tsx` as a route in `App.tsx` and add a sidebar entry in `NAV_ITEMS` under the navigation menu.

#### Scenario: Route accessible

- GIVEN the app is running
- WHEN the user navigates to `/universe`
- THEN the `UniversePage` component renders

#### Scenario: Sidebar entry visible

- GIVEN the sidebar is rendered
- WHEN the user views the navigation
- THEN a "Universe" entry is present and links to `/universe`

### Requirement: CSV File Upload

The system SHALL provide a file input accepting `.csv` files and an upload button. On upload, the frontend SHALL read the file as raw text and send it in a JSON body `{ csv: "..." }` to `POST /api/universe/upload`.

#### Scenario: Successful upload refreshes table

- GIVEN the user selects a valid CSV file
- WHEN the user clicks upload
- THEN the CSV is sent to `POST /api/universe/upload`
- AND the candidate table refreshes to show the updated list

#### Scenario: Upload error shown to user

- GIVEN the API returns a `400` error
- WHEN the upload completes
- THEN an error message is displayed to the user
- AND the table is not refreshed

### Requirement: Candidate Table Display

The system SHALL display all universe candidates in a table with columns: Ticker, Name, Source, Asset Class, Added At. Data SHALL come from `GET /api/universe`.

#### Scenario: Table renders candidates

- GIVEN `GET /api/universe` returns 3 candidates
- WHEN the page loads
- THEN a table with 3 rows is displayed with correct values

#### Scenario: Empty state shown

- GIVEN `GET /api/universe` returns `[]`
- WHEN the page loads
- THEN an empty-state message is displayed

### Requirement: Per-Row Delete

The system SHALL provide a delete button on each table row. On click, it SHALL call `DELETE /api/universe/:ticker` and refresh the table.

#### Scenario: Row deleted successfully

- GIVEN the table shows ticker `AAPL`
- WHEN the user clicks the delete button for `AAPL`
- THEN `DELETE /api/universe/AAPL` is called
- AND the table refreshes without `AAPL`

### Requirement: API Service Functions

The system SHALL add fetch wrapper functions to `services/api.ts`: `uploadUniverseCsv(csvText)`, `getUniverse()`, `deleteUniverseTicker(ticker)`.

#### Scenario: Service functions exist and are importable

- GIVEN the frontend builds successfully
- WHEN `uploadUniverseCsv`, `getUniverse`, `deleteUniverseTicker` are imported from `api.ts`
- THEN no TypeScript errors occur
