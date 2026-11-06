"""All `projection_version`/`projection_scenario` table reads and writes live here
(ADR-029 anti-duplication rule, mirrors investment_repository.py's pattern from Wave 0).
"""

import sqlite3


def save_projection_version(
    conn: sqlite3.Connection,
    investment_id: str,
    version: int,
    saved_at: str,
    analyzed_at: str | None = None,
    model: str | None = None,
    fair_value: float | None = None,
    action: str | None = None,
    rationale: str | None = None,
    research_event_id: str | None = None,
    snapshot_json: str | None = None,
    analytics_log_json: str | None = None,
    source: str | None = None,
    last_grok_sweep: str | None = None,
    catalyst_updates_json: str | None = None,
) -> str:
    """Insert or update a projection version row.

    Upsert on ``(investment_id, version)``: this function persists whatever version
    number it is given and does not compute the next version itself — that
    responsibility stays with the caller, mirroring ``ProjectionService.ts``'s existing
    upsert-by-id-then-version-increment split.

    ``source``/``last_grok_sweep``/``catalyst_updates_json`` mirror the JSON model's
    ``entry.source``/``entry.lastGrokSweep``/``entry.catalystUpdates`` fields (see
    ``db_client.py``'s DDL-drift-check header for the real-data investigation that added
    these columns). Like every other column here, this is a full-row upsert — a caller
    that omits one of these on an update will null it out, so callers updating an
    existing row must pass through the row's current values for anything they don't
    intend to change.
    """
    projection_id = f"{investment_id}:{version}"
    conn.execute(
        "INSERT INTO projection_version "
        "(projection_id, investment_id, version, saved_at, analyzed_at, model, fair_value, "
        "action, rationale, research_event_id, snapshot_json, analytics_log_json, source, "
        "last_grok_sweep, catalyst_updates_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(investment_id, version) DO UPDATE SET "
        "saved_at=excluded.saved_at, analyzed_at=excluded.analyzed_at, model=excluded.model, "
        "fair_value=excluded.fair_value, action=excluded.action, rationale=excluded.rationale, "
        "research_event_id=excluded.research_event_id, snapshot_json=excluded.snapshot_json, "
        "analytics_log_json=excluded.analytics_log_json, source=excluded.source, "
        "last_grok_sweep=excluded.last_grok_sweep, "
        "catalyst_updates_json=excluded.catalyst_updates_json;",
        (
            projection_id, investment_id, version, saved_at, analyzed_at, model, fair_value,
            action, rationale, research_event_id, snapshot_json, analytics_log_json, source,
            last_grok_sweep, catalyst_updates_json,
        ),
    )
    conn.commit()
    return projection_id


def get_latest_projection(conn: sqlite3.Connection, investment_id: str) -> dict | None:
    """Return the highest-version projection row for an investment, or ``None``."""
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(
        "SELECT * FROM projection_version WHERE investment_id = ? "
        "ORDER BY version DESC LIMIT 1;",
        (investment_id,),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def get_latest_projection_by_source(
    conn: sqlite3.Connection, investment_id: str, source: str
) -> dict | None:
    """Return the ``source``-matching projection row with the latest ``saved_at`` for an
    investment, or ``None`` if no row for this investment has that ``source``.

    This is the SQL equivalent of ``apply_catalyst.py``'s ``_find_latest_ai_agent``
    (called with ``source="AI_AGENT"``): filter by source first, then pick the newest by
    ``saved_at`` — deliberately NOT ``MAX(version)`` (``get_latest_projection``'s
    criterion). A real-data investigation (Task 6) found these two criteria disagree for
    real tickers: version numbers are not always chronological (e.g. ``BW``, ``CLSK``,
    ``LITE`` in the real ``projections/`` corpus each have a higher-numbered version with
    an earlier ``savedAt`` than a lower-numbered one), so ``MAX(version)`` alone is not a
    safe substitute for "latest AI_AGENT entry by save time".
    """
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(
        "SELECT * FROM projection_version WHERE investment_id = ? AND source = ? "
        "ORDER BY saved_at DESC LIMIT 1;",
        (investment_id, source),
    )
    row = cursor.fetchone()
    return dict(row) if row else None


def list_symbols_with_projections(conn: sqlite3.Connection) -> list[str]:
    """Return every investment symbol that has at least one ``projection_version``
    row, sorted ascending by symbol.

    SQL equivalent of glob-ing ``projections/*.json`` for filenames (Wave 1 Task
    7B): several consumers (``watchlist_manager.py``'s researched-watchlist
    fallback, ``scan_opportunities.py``'s unowned-INITIATE scan) previously
    enumerated every ticker with an on-disk projection file, regardless of that
    projection's ``source``, before filtering per-ticker. This is the
    ``investment``/``projection_version`` join that reproduces that enumeration
    against the database.
    """
    cursor = conn.execute(
        "SELECT DISTINCT i.symbol FROM investment i "
        "JOIN projection_version pv ON pv.investment_id = i.investment_id "
        "ORDER BY i.symbol ASC;"
    )
    return [row[0] for row in cursor.fetchall()]


def list_projection_versions(conn: sqlite3.Connection, investment_id: str) -> list[dict]:
    """Return all projection versions for an investment, ascending by version.

    Mirrors ``ProjectionService.getProjections()``'s full-array return shape.
    """
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(
        "SELECT * FROM projection_version WHERE investment_id = ? ORDER BY version ASC;",
        (investment_id,),
    )
    return [dict(row) for row in cursor.fetchall()]


def add_projection_scenario(
    conn: sqlite3.Connection,
    projection_id: str,
    scenario_name: str,
    weight: float | None = None,
    growth_rate: float | None = None,
    net_margin: float | None = None,
    exit_pe: float | None = None,
    quality_multiplier: float | None = None,
    share_change: float | None = None,
    rationale: str | None = None,
    moat_score: int | None = None,
    management_score: int | None = None,
    year5_revenue: float | None = None,
    year5_net_income: float | None = None,
    year5_eps: float | None = None,
    scenario_price: float | None = None,
    risks_json: str | None = None,
) -> str:
    """Insert or update a projection scenario row. Upsert on ``(projection_id, scenario_name)``."""
    scenario_id = f"{projection_id}:{scenario_name}"
    conn.execute(
        "INSERT INTO projection_scenario "
        "(scenario_id, projection_id, scenario_name, weight, growth_rate, net_margin, exit_pe, "
        "quality_multiplier, share_change, rationale, moat_score, management_score, "
        "year5_revenue, year5_net_income, year5_eps, scenario_price, risks_json) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(projection_id, scenario_name) DO UPDATE SET "
        "weight=excluded.weight, growth_rate=excluded.growth_rate, "
        "net_margin=excluded.net_margin, exit_pe=excluded.exit_pe, "
        "quality_multiplier=excluded.quality_multiplier, share_change=excluded.share_change, "
        "rationale=excluded.rationale, moat_score=excluded.moat_score, "
        "management_score=excluded.management_score, year5_revenue=excluded.year5_revenue, "
        "year5_net_income=excluded.year5_net_income, year5_eps=excluded.year5_eps, "
        "scenario_price=excluded.scenario_price, risks_json=excluded.risks_json;",
        (
            scenario_id, projection_id, scenario_name, weight, growth_rate, net_margin, exit_pe,
            quality_multiplier, share_change, rationale, moat_score, management_score,
            year5_revenue, year5_net_income, year5_eps, scenario_price, risks_json,
        ),
    )
    conn.commit()
    return scenario_id


def get_projection_scenarios(conn: sqlite3.Connection, projection_id: str) -> list[dict]:
    """Return all scenario rows for a projection. Empty list, not an error, for legacy
    projections that have no ``scenarios`` block (apply_catalyst.py:176-179)."""
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(
        "SELECT * FROM projection_scenario WHERE projection_id = ?;", (projection_id,),
    )
    return [dict(row) for row in cursor.fetchall()]


def get_preferred_projection(conn: sqlite3.Connection, investment_id: str) -> dict | None:
    """The projection every valuation call uses: latest AI_AGENT, else the highest version."""
    return get_latest_projection_by_source(conn, investment_id, "AI_AGENT") or get_latest_projection(conn, investment_id)
