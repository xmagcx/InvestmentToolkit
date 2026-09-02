# DDL drift check (performed at authoring time, re-run whenever this file changes):
# Source: docs/architecture/domain-data-model.md (account, strategy_pillar, sub_strategy,
#   investment, investment_price, account_investment, price_level_set, price_level_tier,
#   alert, investment_note, projection_version, projection_scenario, portfolio_policy)
#   + docs/architecture/supplementary-domain-schemas.md (trade_log_entry, order_execution,
#   cash_flow, cash_flow_baseline).
#
# Method: every column/type/constraint below was diffed, table by table, against the
# "v3 Column-Level Schema" SQL block (domain-data-model.md lines ~305-475), the `alert` and
# `investment_note` CREATE TABLE blocks in the same file's "Response to Review" section, and the
# markdown column tables for trade_log_entry/order_execution/cash_flow/cash_flow_baseline in
# supplementary-domain-schemas.md (Domain 2, 3, 4 section).
#
# Deviations from source documents (must be empty, or each entry must be justified):
#   - projection_version.research_event_id: source docs show this as
#     "REFERENCES intelligence_event(event_id)" but that table lives in a different SQLite
#     file (intelligence.sqlite) than this one (domain_model's own .sqlite) — SQLite cannot
#     enforce a cross-database FK, so this column is declared without a REFERENCES clause here.
#     Referential integrity for this link is enforced at the repository layer (Wave 1's
#     projection repository must validate the event_id exists before insert), not by SQLite.
#     Same reasoning applies to investment.latest_research_event_id.
#   - trade_log_entry.account_id: supplementary-domain-schemas.md's own column table for
#     trade_log_entry (Domain 2, 3, 4 section) literally lists this as a plain `account` TEXT
#     field ("e.g. TFSA, RRSP") with no FK notation. This file instead names/types it
#     `account_id TEXT REFERENCES account(account_id)`. That choice is not arbitrary — it matches
#     domain-data-model.md's v3 Mermaid ERD, which shows `TRADE_LOG_ENTRY { TEXT account_id FK }`
#     and an explicit `ACCOUNT ||--o{ TRADE_LOG_ENTRY : "logged against"` relationship. The two
#     named source documents disagree with each other on this one column; this file follows the
#     newer, FK-relationship-bearing domain-data-model.md version rather than the older plain-text
#     column table in supplementary-domain-schemas.md. Flagged so a reviewer can confirm that
#     choice, not silently pick a side.
#   - cash_flow.account: for contrast, this column was left as plain `account TEXT` with no
#     rename/FK, even though domain-data-model.md's v3 Mermaid ERD shows the same
#     `TEXT account_id FK` treatment for CASH_FLOW that it shows for TRADE_LOG_ENTRY. This file's
#     cash_flow DDL instead matches supplementary-domain-schemas.md's plain `account` column
#     table verbatim. Net effect: the "does `account` get promoted to `account_id` with a real
#     FK" question was answered inconsistently between these two tables — trade_log_entry says
#     yes, cash_flow says no — even though both source documents show the exact same ambiguity
#     for both tables. Not fixed here (Task 1 is schema transcription, not schema redesign);
#     flagged for a follow-up decision before Wave 1's portfolio-ledger repository work assumes
#     one behavior or the other.
#   - portfolio_policy: Step 3 of this task's brief cites this table's DDL as coming from
#     "domain-data-model.md § Missing top-level PORTFOLIO/config entity" — that section heading
#     does not exist anywhere in domain-data-model.md (checked: the file's full heading list has
#     no "PORTFOLIO" or "policy" section at all). The DDL is schema-consistent with
#     docs/superpowers/specs/2026-07-19-domain-data-model-v3-implementation-design.md §2.14
#     ("Account/portfolio policy" — same five numeric caps/bands, same two JSON rule-blob
#     columns), but that spec file is not one of the two files this task names as the DDL source,
#     and it does not itself spell out exact column names (`policy_id`, `rebalance_frequency`,
#     etc.) — those exact names only appear pre-written in this task's own implementation plan
#     document. This is a citation-accuracy issue (the brief points at a document section that
#     isn't there), not a schema-content issue — the columns below are internally consistent with
#     every real design document that discusses `portfolio_policy`, just not literally
#     "transcribed verbatim" from either of the two files named for that purpose in Step 3.
#   - projection_version.raw_json / projection_version.legacy_id: not present in the
#     source design documents. Added post-hoc (Wave 1 Task 5 review fix) so this file
#     stays the single source of truth for the shared schema — these two nullable
#     columns previously existed ONLY as a runtime `ALTER TABLE` issued by
#     `ProjectionRepository.ts`'s constructor against the real, shared
#     `domain_model.sqlite` file, which is what let a TypeScript import silently mutate
#     production schema outside this module. `raw_json` holds the full validated
#     `Projection` object (round-trip fidelity for `.passthrough()` fields the
#     structured columns don't model); `legacy_id` holds the original Zod `Projection.id`
#     UUID used to group version rows by projection identity. See ProjectionRepository.ts
#     module docstring for the full design rationale.
#   - projection_version.source / last_grok_sweep / catalyst_updates_json: not present in
#     the source design documents. Added post-hoc (Wave 1 Task 6, apply_catalyst.py
#     rewire) after a real-data investigation found `projection_version` had no way to
#     represent the JSON model's `entry.source` (`AI_AGENT`/`USER`/`SYSTEM`/`ETF_ANALYSIS`),
#     `entry.lastGrokSweep`, or `entry.catalystUpdates` fields — all three are read/written
#     by `apply_catalyst.py` and are real, present data (19/132 and 18/132 real
#     `projections/*.json` entries carry `lastGrokSweep`/`catalystUpdates` respectively; 8
#     of 82 real tickers have zero `AI_AGENT`-sourced entries, only `ETF_ANALYSIS`). Without
#     `source`, `apply_catalyst.py`'s `_find_latest_ai_agent` (source-filtered, latest by
#     `savedAt`) has no SQL equivalent — `get_latest_projection`'s `MAX(version)` alone
#     silently picks a non-`AI_AGENT` row for those 8 tickers and, separately, a
#     stale/wrong-source row for 3 more real tickers whose version numbers are not
#     chronological (`BW`, `CLSK`, `LITE` — confirmed by direct comparison against real
#     `projections/*.json`). `last_grok_sweep`/`catalyst_updates_json` are added so
#     `--record-sweep` and the catalyst-apply write path have somewhere to persist their
#     stamped date / appended catalyst-log entries, matching the JSON model's fields
#     one-for-one. `migrate_projections_to_sqlite.py` is updated to populate all three for
#     future migration runs. CORRECTION (Wave 1 Task 6 follow-up fix): the original note
#     here claimed the real file's 115 already-migrated rows "have NULL in these columns"
#     — that was wrong. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that
#     already exists, so the three columns did not exist in the real file's schema at
#     all (verified via `PRAGMA table_info`/`.schema projection_version`), not merely
#     NULL-valued. Fixed via the schema self-heal in `_evolve_schema`/`SCHEMA_EVOLUTIONS`
#     below, which runs an `ALTER TABLE ... ADD COLUMN` for any table+column pair
#     registered there that is missing from an existing file. The real file's `source`
#     column has since been backfilled from `projections/*.json` (see
#     `migrate_projections_to_sqlite.py --backfill-source`); `last_grok_sweep`/
#     `catalyst_updates_json` remain NULL on those 115 pre-existing rows (optional/future
#     backfill, not required for `apply_catalyst.py` to function).
#   - broker_exchange_rate: not present in either named source design document.
#     Added post-hoc (Wave 3 Task 8, CAD exchange-rate gap closure) per an explicit
#     user design decision recorded in ADR-030's "Wave 3 addendum" section. This is
#     the ONE broker-reported fact that cannot be derived from anything else the
#     schema stores: the live USD->CAD FX rate, inferred at sync time from
#     TradingView's own native totalEquityCADCombined/totalEquityUSDCombined ratio
#     (CLAUDE.md pitfall #27 — never an external FX API). It is deliberately a
#     singleton (CHECK(id = 1), one row ever, overwritten each sync), NOT a
#     per-account or historical table — mirroring investment_price's "store this one
#     broker fact, don't invent history we don't need" shape. CAD-denominated totals
#     are explicitly NOT stored: every CAD figure is computed as usd_value * rate at
#     read time, matching ADR-030's "store facts, compute aggregates" principle (the
#     rate is a fact; CAD totals derived from it are aggregates). Both readers —
#     helpers.ts::getLiveUsdCadRate() (TS) and
#     portfolio_repository.py::load_portfolio_state_from_db() (Python) — now read this
#     scalar with a static fallback for a fresh/never-synced DB, closing the
#     retained-JSON gap documented in
#     docs/superpowers/status/wave3-cad-exchange-rate-retained-json.md.
#   - broker_reported_total: not present in either named source design document.
#     Added post-hoc (Wave 3 Task 8, tvSnapshot closure) per an explicit user
#     design decision recorded in ADR-030's "Wave 3 addendum" pattern. This is the
#     broker's OWN last-reported portfolio total (totalUSD, and totalCAD if present)
#     — a broker-reported FACT the schema cannot recompute (same reasoning as
#     broker_exchange_rate above), captured for exactly one consumer:
#     verify_portfolio_total.py's reconciliation/audit check, which compares the
#     broker's reported total against get_portfolio_total_value()'s computed total.
#     This does NOT reverse ADR-030: get_portfolio_total_value() remains the
#     authoritative computed total for everything else; this scalar is stored only
#     as the reconciliation comparison SOURCE (the audited-against figure), not as
#     "the" total. Singleton (CHECK(id = 1), one row ever, overwritten each sync),
#     mirroring broker_exchange_rate's "store this one broker fact" shape. `source`
#     holds the portfolio.json totals.totalSource value (e.g. "tv_authoritative").
#   - investment.sector / investment.industry: not present in either named source
#     design document. Added post-hoc (Wave 3 completion, last-portfolio.json-write
#     closure) per an explicit user design decision. sector/industry are the only
#     enriched holding-display facts GET /api/portfolio needed from portfolio.json
#     that the schema did not already carry (name and pillar_id were added in
#     Wave 0/2). They are resolved by the SAME real code path that resolves them
#     today — fetch_portfolio_heatmap.py's yfinance info.get("sector")/("industry")
#     lookup (with SECTOR_OVERRIDES) during a /refresh-prices call — and persisted
#     alongside the fresh price into investment via update_investment_sector(). Both
#     are nullable TEXT (a freshly TV-synced-but-not-yet-price-refreshed investment
#     has no resolved sector yet; readers fall back to "Unknown", matching
#     fetch_portfolio_heatmap.py's own fallback). Registered in SCHEMA_EVOLUTIONS so
#     the real, already-existing domain_model.sqlite self-heals these two columns.
#   - (no other deviations found as of this transcription)
import sqlite3

# Schema-evolution registry: for each table, the set of (column, type) pairs that
# `CREATE TABLE IF NOT EXISTS` cannot add to a file that already exists with an older
# shape of that table (SQLite silently no-ops the CREATE when the table is already
# present, even if its column list is missing newer columns declared here). Every column
# added to `projection_version` (or any future table) alongside a real DDL change should
# be added here as well as in the `CREATE TABLE IF NOT EXISTS` block above, so existing
# real database files self-heal to the current schema on their very next
# `initialize_db()` call instead of silently drifting from the canonical DDL.
#
# `_evolve_schema` (below) is intentionally general — it will diff and patch any table
# listed here, not just `projection_version` — but only `projection_version` is
# populated today. This closes the real gap found in Wave 1 Task 6 review: the
# `source`/`last_grok_sweep`/`catalyst_updates_json` columns were added to this file's
# canonical DDL but never actually reached the real, already-existing
# `domain_model.sqlite` file because `CREATE TABLE IF NOT EXISTS` is a no-op against it.
SCHEMA_EVOLUTIONS: dict[str, list[tuple[str, str]]] = {
    "projection_version": [
        ("source", "TEXT"),
        ("last_grok_sweep", "TEXT"),
        ("catalyst_updates_json", "TEXT"),
    ],
    "investment": [
        ("sector", "TEXT"),
        ("industry", "TEXT"),
        ("last_deep_analysis_at", "TEXT"),
    ],
    "trade_log_entry": [
        ("tv_order_id", "TEXT"),
    ],
}


def _evolve_schema(conn: sqlite3.Connection) -> None:
    """Self-heal an existing database file's schema against `SCHEMA_EVOLUTIONS`.

    For each table listed in `SCHEMA_EVOLUTIONS`, reads the table's actual columns via
    `PRAGMA table_info(<table>)` and runs `ALTER TABLE <table> ADD COLUMN <col> <type>`
    for any declared column missing from the real file. Idempotent and safe to call on
    every `initialize_db()` invocation, against a brand-new file (where `CREATE TABLE IF
    NOT EXISTS` already created the column and this is a no-op) or an existing file
    created under an older schema (where this is the only thing that actually adds the
    column). Additive only — never drops or alters an existing column, so no data loss.
    """
    for table, columns in SCHEMA_EVOLUTIONS.items():
        existing = {
            row[1] for row in conn.execute(f"PRAGMA table_info({table});").fetchall()
        }
        for column, col_type in columns:
            if column not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type};")


def initialize_db(db_path: str) -> sqlite3.Connection:
    """Open (creating if absent) the v3.2 domain-model SQLite database.

    Mirrors ``py_services/intelligence/db_client.py::initialize_db``'s calling
    convention: WAL mode, foreign keys on, idempotent schema creation.
    """
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")

    conn.execute("""
    CREATE TABLE IF NOT EXISTS account (
        account_id      TEXT PRIMARY KEY,
        account_name    TEXT NOT NULL,
        account_type    TEXT,
        base_currency   TEXT NOT NULL DEFAULT 'CAD'
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS strategy_pillar (
        pillar_id       TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        target_weight   REAL
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS sub_strategy (
        sub_strategy_id TEXT PRIMARY KEY,
        pillar_id       TEXT REFERENCES strategy_pillar(pillar_id),
        name            TEXT NOT NULL
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS investment (
        investment_id              TEXT PRIMARY KEY,
        symbol                      TEXT NOT NULL,
        name                        TEXT,
        sector                      TEXT,
        industry                    TEXT,
        asset_class                 TEXT NOT NULL,
        currency                    TEXT NOT NULL DEFAULT 'USD',
        lifecycle_status            TEXT,
        target_weight               REAL,
        target_action               TEXT,
        standing_decision_type      TEXT,
        standing_decision_reason    TEXT,
        standing_decision_source    TEXT,
        standing_decision_review    TEXT,
        pillar_id                   TEXT REFERENCES strategy_pillar(pillar_id),
        sub_strategy_id             TEXT REFERENCES sub_strategy(sub_strategy_id),
        thesis_for_inclusion        TEXT,
        agent_rationale             TEXT,
        is_watchlisted              INTEGER NOT NULL DEFAULT 0,
        watchlist_added_at          TEXT,
        latest_projection_id        TEXT REFERENCES projection_version(projection_id),
        latest_research_event_id    TEXT,
        thesis_breaker_status       TEXT,
        last_deep_analysis_at       TEXT,
        updated_at                  TEXT NOT NULL,
        UNIQUE(symbol)
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS investment_price (
        investment_id   TEXT PRIMARY KEY REFERENCES investment(investment_id),
        price           REAL NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'USD',
        fetched_at      TEXT NOT NULL
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS account_investment (
        account_investment_id   TEXT PRIMARY KEY,
        account_id              TEXT NOT NULL REFERENCES account(account_id),
        investment_id           TEXT NOT NULL REFERENCES investment(investment_id),
        quantity                REAL NOT NULL DEFAULT 0,
        average_cost            REAL,
        book_value              REAL,
        currency                TEXT NOT NULL DEFAULT 'USD',
        last_synced_at          TEXT NOT NULL,
        UNIQUE(account_id, investment_id)
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS price_level_set (
        price_level_set_id  TEXT PRIMARY KEY,
        investment_id       TEXT NOT NULL REFERENCES investment(investment_id),
        schema_version      TEXT,
        last_updated        TEXT,
        last_updated_by     TEXT,
        note                TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS price_level_tier (
        tier_id              TEXT PRIMARY KEY,
        price_level_set_id   TEXT NOT NULL REFERENCES price_level_set(price_level_set_id),
        tier_kind            TEXT NOT NULL DEFAULT 'BUY_TIER',
        tier_number          INTEGER NOT NULL,
        price                REAL,
        action               TEXT,
        trim_pct             REAL,
        order_type           TEXT,
        basis                TEXT,
        source               TEXT,
        source_date          TEXT,
        condition            TEXT,
        status               TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS alert (
        alert_id        TEXT PRIMARY KEY,
        investment_id   TEXT REFERENCES investment(investment_id),
        alert_type      TEXT,
        message         TEXT,
        price           REAL,
        condition_json  TEXT,
        active          INTEGER NOT NULL DEFAULT 1,
        resolution      TEXT,
        created_at      TEXT,
        last_fired_at   TEXT,
        expiration_at   TEXT,
        synced_at       TEXT NOT NULL
    );
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_alert_investment ON alert(investment_id);")

    conn.execute("""
    CREATE TABLE IF NOT EXISTS investment_note (
        note_id         TEXT PRIMARY KEY,
        investment_id   TEXT NOT NULL REFERENCES investment(investment_id),
        note_date       TEXT NOT NULL,
        note_type       TEXT,
        body            TEXT NOT NULL,
        source          TEXT
    );
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_investment_note_investment "
        "ON investment_note(investment_id, note_date);"
    )

    conn.execute("""
    CREATE TABLE IF NOT EXISTS projection_version (
        projection_id         TEXT PRIMARY KEY,
        investment_id         TEXT NOT NULL REFERENCES investment(investment_id),
        version               INTEGER NOT NULL,
        saved_at              TEXT NOT NULL,
        analyzed_at           TEXT,
        model                 TEXT,
        fair_value            REAL,
        action                TEXT,
        rationale             TEXT,
        research_event_id     TEXT,
        snapshot_json         TEXT,
        analytics_log_json    TEXT,
        raw_json               TEXT,
        legacy_id               TEXT,
        source                   TEXT,
        last_grok_sweep          TEXT,
        catalyst_updates_json    TEXT,
        UNIQUE(investment_id, version)
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS projection_scenario (
        scenario_id         TEXT PRIMARY KEY,
        projection_id       TEXT NOT NULL REFERENCES projection_version(projection_id),
        scenario_name       TEXT NOT NULL,
        weight              REAL,
        growth_rate         REAL,
        net_margin          REAL,
        exit_pe             REAL,
        quality_multiplier  REAL,
        share_change        REAL,
        rationale           TEXT,
        moat_score          INTEGER,
        management_score    INTEGER,
        year5_revenue       REAL,
        year5_net_income    REAL,
        year5_eps           REAL,
        scenario_price      REAL,
        risks_json          TEXT,
        UNIQUE(projection_id, scenario_name)
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS trade_log_entry (
        entry_id        TEXT PRIMARY KEY,
        investment_id   TEXT NOT NULL REFERENCES investment(investment_id),
        account_id      TEXT REFERENCES account(account_id),
        action          TEXT,
        shares          REAL,
        price           REAL,
        total_cost      REAL,
        order_type      TEXT,
        limit_price     REAL,
        trade_date      TEXT,
        notes           TEXT,
        status          TEXT,
        source          TEXT,
        priority        TEXT,
        logged_at       TEXT,
        tv_order_id     TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS order_execution (
        execution_id      TEXT PRIMARY KEY,
        executed_at       TEXT NOT NULL,
        investment_id     TEXT NOT NULL REFERENCES investment(investment_id),
        side              TEXT,
        shares            REAL,
        price             REAL,
        decision          TEXT,
        gate_result_json  TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS cash_flow (
        flow_id                             TEXT PRIMARY KEY,
        flow_date                           TEXT,
        flow_type                           TEXT,
        amount_cad                          REAL,
        portfolio_value_before_flow_cad      REAL,
        account                              TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS cash_flow_baseline (
        account                TEXT PRIMARY KEY,
        starting_balance_cad   REAL,
        starting_date          TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS portfolio_policy (
        policy_id                                TEXT PRIMARY KEY,
        rebalance_frequency                      TEXT,
        portfolio_value_usd_target               REAL,
        max_marginal_risk_contribution_pct        REAL,
        max_cluster_variance_contribution_pct      REAL,
        rebalance_band_relative_pct                REAL,
        rebalance_band_absolute_pct                REAL,
        rebalance_band_critical_multiplier          REAL,
        account_preference_rules_json                TEXT,
        psu_funding_rule_json                          TEXT,
        updated_at                                      TEXT NOT NULL
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS portfolio_change_log (
        entry_id        TEXT PRIMARY KEY,
        version         TEXT NOT NULL,
        entry_date      TEXT NOT NULL,
        note            TEXT NOT NULL,
        created_at      TEXT NOT NULL
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS broker_exchange_rate (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        usd_to_cad_rate REAL NOT NULL,
        synced_at       TEXT NOT NULL
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS broker_reported_total (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        total_usd       REAL NOT NULL,
        total_cad       REAL,
        synced_at       TEXT NOT NULL,
        source          TEXT
    );
    """)

    conn.execute("""
    CREATE TABLE IF NOT EXISTS universe_candidate (
        ticker      TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        source      TEXT NOT NULL,
        asset_class TEXT,
        added_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    """)

    conn.execute("CREATE INDEX IF NOT EXISTS idx_investment_pillar ON investment(pillar_id);")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_investment_lifecycle ON investment(lifecycle_status);"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_investment_account "
        "ON account_investment(account_id);"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_account_investment_investment "
        "ON account_investment(investment_id);"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_projection_investment "
        "ON projection_version(investment_id);"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_projection_scenario_projection "
        "ON projection_scenario(projection_id);"
    )

    _evolve_schema(conn)

    conn.commit()
    return conn
