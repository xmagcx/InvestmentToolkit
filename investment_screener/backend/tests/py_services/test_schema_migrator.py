import sqlite3
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from domain_model import schema_migrator  # noqa: E402
from domain_model.db_client import initialize_db  # noqa: E402
from domain_model.schema_migrator import SchemaError, discover, migrate  # noqa: E402
from legacy_db import make_legacy_db  # noqa: E402


def _write(dir_: Path, name: str, sql: str, *, header: bool = True) -> None:
    """Write a migration file; by default prepend the mandatory description line."""
    stem = name[:-4]
    prefix = f"-- {stem}: test migration for {stem.split('_', 1)[-1]}\n" if header else ""
    (dir_ / name).write_text(prefix + sql)


def _baseline_only_dir(tmp_path: Path) -> Path:
    """A migrations directory holding just 0001_baseline.sql, whatever migrations come after it."""
    d = tmp_path / "baseline_only"
    d.mkdir()
    (d / "0001_baseline.sql").write_text((Path(schema_migrator.MIGRATIONS_DIR) / "0001_baseline.sql").read_text())
    return d


def _migrate_to_baseline(path: Path, tmp_path: Path) -> None:
    conn = sqlite3.connect(str(path))
    migrate(conn, db_path=str(path), directory=_baseline_only_dir(tmp_path))
    conn.close()


@pytest.fixture
def mig_dir(tmp_path):
    d = tmp_path / "migs"
    d.mkdir()
    _write(d, "0001_base.sql", "CREATE TABLE widget (id INTEGER PRIMARY KEY, label TEXT);\n")
    return d


def test_fresh_database_gets_baseline_ledger_and_user_version(tmp_path):
    conn = initialize_db(str(tmp_path / "fresh.sqlite"))
    versions = [r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
    assert versions == [m.version for m in discover()]
    assert conn.execute("PRAGMA user_version").fetchone()[0] == versions[-1]


def test_initialize_db_is_idempotent(tmp_path):
    path = str(tmp_path / "again.sqlite")
    initialize_db(path).close()
    conn = initialize_db(path)
    assert migrate(conn, db_path=path) == []


def test_pending_migration_applies_once_and_bumps_user_version(tmp_path, mig_dir):
    conn = sqlite3.connect(str(tmp_path / "m.sqlite"))
    assert migrate(conn, directory=mig_dir) == [1]
    _write(mig_dir, "0002_add_col.sql", "ALTER TABLE widget ADD COLUMN size INTEGER;\n")
    assert migrate(conn, directory=mig_dir) == [2]
    assert migrate(conn, directory=mig_dir) == []
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    assert "size" in {r[1] for r in conn.execute("PRAGMA table_info(widget)")}


def test_failed_migration_rolls_back_completely(tmp_path, mig_dir):
    conn = sqlite3.connect(str(tmp_path / "m.sqlite"))
    migrate(conn, directory=mig_dir)
    _write(
        mig_dir,
        "0002_bad.sql",
        "ALTER TABLE widget ADD COLUMN ok_col INTEGER;\nCREATE TABLE widget (dup INTEGER);\n",
    )
    with pytest.raises(SchemaError, match="rolled back"):
        migrate(conn, directory=mig_dir)
    assert "ok_col" not in {r[1] for r in conn.execute("PRAGMA table_info(widget)")}
    assert conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 1


def test_editing_an_applied_migration_is_refused(tmp_path, mig_dir):
    conn = sqlite3.connect(str(tmp_path / "m.sqlite"))
    migrate(conn, directory=mig_dir)
    _write(mig_dir, "0001_base.sql", "CREATE TABLE widget (id INTEGER PRIMARY KEY, label TEXT, extra TEXT);\n")
    with pytest.raises(SchemaError, match="edited after it was applied"):
        migrate(conn, directory=mig_dir)


def test_database_newer_than_checkout_is_refused(tmp_path, mig_dir):
    conn = sqlite3.connect(str(tmp_path / "m.sqlite"))
    _write(mig_dir, "0002_more.sql", "CREATE TABLE gadget (id INTEGER PRIMARY KEY);\n")
    migrate(conn, directory=mig_dir)
    (mig_dir / "0002_more.sql").unlink()
    with pytest.raises(SchemaError, match="older than the database"):
        migrate(conn, directory=mig_dir)


def test_gap_in_migration_numbers_is_refused(mig_dir):
    _write(mig_dir, "0003_skip.sql", "SELECT 1;\n")
    with pytest.raises(SchemaError, match="contiguous"):
        discover(mig_dir)


def test_bad_filename_is_refused(mig_dir):
    _write(mig_dir, "add-thing.sql", "SELECT 1;\n")
    with pytest.raises(SchemaError, match="must be named"):
        discover(mig_dir)


def test_legacy_file_is_adopted_with_data_intact_and_stamped(tmp_path):
    path = str(tmp_path / "legacy.sqlite")
    make_legacy_db(path)
    raw = sqlite3.connect(path)
    raw.execute(
        "INSERT INTO investment (investment_id, symbol, asset_class, currency, updated_at) "
        "VALUES ('x-1', 'XYZ', 'EQUITY', 'USD', '2026-01-01T00:00:00Z')"
    )
    raw.commit()
    raw.close()

    conn = initialize_db(path)
    assert conn.execute("SELECT symbol FROM investment WHERE investment_id='x-1'").fetchone()[0] == "XYZ"
    assert {"sector", "industry"} <= {r[1] for r in conn.execute("PRAGMA table_info(investment)")}
    assert conn.execute("SELECT MIN(version) FROM schema_migrations").fetchone()[0] == 1


def test_legacy_file_missing_a_whole_table_gets_it_created(tmp_path):
    path = str(tmp_path / "legacy.sqlite")
    make_legacy_db(path)
    raw = sqlite3.connect(path)
    raw.execute("DROP TABLE broker_reported_total")
    raw.commit()
    raw.close()
    conn = initialize_db(path)
    assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='broker_reported_total'").fetchone()


def test_drifted_legacy_file_is_refused_and_left_untouched(tmp_path):
    path = str(tmp_path / "drifted.sqlite")
    make_legacy_db(path)
    raw = sqlite3.connect(path)
    raw.execute("ALTER TABLE account DROP COLUMN base_currency")
    raw.commit()
    before = sorted(r[0] for r in raw.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL"))
    raw.close()

    with pytest.raises(SchemaError, match="refusing to adopt"):
        initialize_db(path)

    after_conn = sqlite3.connect(path)
    after = sorted(r[0] for r in after_conn.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL"))
    assert after == before, "a refused adoption must not alter the file"
    assert not after_conn.execute("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone()


def test_populated_database_is_backed_up_before_a_pending_migration(tmp_path):
    path = tmp_path / "pop.sqlite"
    make_legacy_db(str(path))  # populated, un-stamped
    _migrate_to_baseline(path, tmp_path)
    backups = list((tmp_path / "backups").glob("pop.*.pre-migration-*.sqlite"))
    # Adoption (stamping) is not a schema change, so no backup is needed for it...
    assert backups == []
    # ...but a real pending migration on a populated file must be preceded by one.
    d = tmp_path / "migs"
    d.mkdir()
    base = (Path(schema_migrator.MIGRATIONS_DIR) / "0001_baseline.sql").read_text()
    _write(d, "0001_baseline.sql", base, header=False)  # byte-identical to the real baseline
    _write(d, "0002_marker.sql", "CREATE TABLE marker (id INTEGER PRIMARY KEY);\n")
    conn = sqlite3.connect(str(path))
    # Ledger holds the real baseline checksum, identical text, so this applies only 0002.
    migrate(conn, db_path=str(path), directory=d)
    found = list((tmp_path / "backups").glob("pop.*.pre-migration-0002.sqlite"))
    assert len(found) == 1


# --- descriptions and version history -------------------------------------------------


def test_migration_without_a_description_line_is_refused(mig_dir):
    _write(mig_dir, "0002_nodesc.sql", "CREATE TABLE gadget (id INTEGER);\n", header=False)
    with pytest.raises(SchemaError, match="first line must be a comment"):
        discover(mig_dir)


def test_too_short_description_is_refused(mig_dir):
    (mig_dir / "0002_tiny.sql").write_text("-- 0002_tiny: stuff\nCREATE TABLE gadget (id INTEGER);\n")
    with pytest.raises(SchemaError, match="too short"):
        discover(mig_dir)


def test_header_that_names_a_different_file_is_refused(mig_dir):
    (mig_dir / "0002_real.sql").write_text(
        "-- 0007_other: this header names a different migration entirely\nSELECT 1;\n"
    )
    with pytest.raises(SchemaError, match="header says 0007_other"):
        discover(mig_dir)


def test_header_without_number_prefix_is_accepted(mig_dir):
    (mig_dir / "0002_plain.sql").write_text(
        "-- Add a gadget table for the new gadget feature\nCREATE TABLE gadget (id INTEGER);\n"
    )
    assert discover(mig_dir)[1].description == "Add a gadget table for the new gadget feature"


def test_tables_touched_is_detected_from_the_sql(mig_dir):
    (mig_dir / "0002_many.sql").write_text(
        "-- 0002_many: touches several tables in different ways\n"
        "CREATE TABLE gadget (id INTEGER PRIMARY KEY, widget_id INTEGER);\n"
        "ALTER TABLE widget ADD COLUMN size INTEGER;\n"
        "CREATE UNIQUE INDEX idx_gadget_w ON gadget(widget_id);\n"
        "INSERT INTO widget (label) VALUES ('x');\n"
        "-- DROP TABLE not_real;  (a comment, must be ignored)\n"
    )
    assert discover(mig_dir)[1].tables == ("gadget", "widget")


def test_history_on_a_fresh_database_has_full_metadata(tmp_path):
    conn = initialize_db(str(tmp_path / "fresh.sqlite"))
    rows = schema_migrator.history(conn)
    assert [r["version"] for r in rows] == [m.version for m in discover()]
    first = rows[0]
    assert first["name"] == "baseline"
    assert first["kind"] == "applied"
    assert len(first["description"]) >= 15
    assert first["applied_at"] and first["checksum"]
    assert first["duration_ms"] >= 0
    assert "account" in first["tables_touched"] and "investment" in first["tables_touched"]
    assert first["backup_file"] is None  # empty database: nothing to back up


def test_legacy_adoption_is_recorded_as_adopted(tmp_path):
    path = str(tmp_path / "legacy.sqlite")
    make_legacy_db(path)
    rows = schema_migrator.history(initialize_db(path))
    assert rows[0]["kind"] == "adopted"
    assert rows[0]["description"]


def test_pending_migration_on_populated_db_records_its_backup(tmp_path):
    path = tmp_path / "pop2.sqlite"
    _migrate_to_baseline(path, tmp_path)  # now at the baseline, populated
    d = tmp_path / "migs2"
    d.mkdir()
    (d / "0001_baseline.sql").write_text((Path(schema_migrator.MIGRATIONS_DIR) / "0001_baseline.sql").read_text())
    _write(d, "0002_marker.sql", "CREATE TABLE marker (id INTEGER PRIMARY KEY);\n")
    conn = sqlite3.connect(str(path))
    migrate(conn, db_path=str(path), directory=d)
    row = [r for r in schema_migrator.history(conn) if r["version"] == 2][0]
    assert "pre-migration-0002" in row["backup_file"]
    assert Path(row["backup_file"]).is_file()
    assert row["tables_touched"] == "marker"
    assert "test migration for marker" in row["description"]


def test_description_with_quotes_round_trips(tmp_path, mig_dir):
    (mig_dir / "0002_quote.sql").write_text(
        "-- 0002_quote: add the table that 'quoted' text won't break\nCREATE TABLE gadget (id INTEGER);\n"
    )
    conn = sqlite3.connect(str(tmp_path / "q.sqlite"))
    migrate(conn, directory=mig_dir)
    assert schema_migrator.history(conn)[1]["description"] == "add the table that 'quoted' text won't break"


def test_old_ledger_without_metadata_columns_is_upgraded(tmp_path, mig_dir):
    conn = sqlite3.connect(str(tmp_path / "o.sqlite"))
    conn.executescript(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, "
        "checksum TEXT NOT NULL, applied_at TEXT NOT NULL);"
    )
    migrate(conn, directory=mig_dir)
    columns = {r[1] for r in conn.execute("PRAGMA table_info(schema_migrations)")}
    assert {"description", "kind", "applied_by", "git_commit", "duration_ms", "tables_touched", "backup_file"} <= columns


def test_cli_status_and_history_show_descriptions(tmp_path, capsys):
    import json as _json

    path = str(tmp_path / "cli.sqlite")
    initialize_db(path).close()
    assert schema_migrator.main(["--db", path, "--history"]) == 0
    out = capsys.readouterr().out
    assert "0001  baseline  [applied]" in out and "tables:" in out and "checksum:" in out
    assert schema_migrator.main(["--db", path, "--status"]) == 0
    assert "pending: none" in capsys.readouterr().out
    assert schema_migrator.main(["--db", path, "--history", "--json"]) == 0
    assert _json.loads(capsys.readouterr().out)[0]["name"] == "baseline"


# --- adopting a database that already holds a later migration's table -----------------
#
# A branch that pre-dates the migrator can build a table by hand in db_client.py. When the
# same file is then opened by a checkout where that table is a numbered migration, adoption
# must keep the data and let the migration be a no-op, as long as the live shape is exactly
# what that migration builds and the migration guards its CREATE with IF NOT EXISTS.


def _baseline_plus(tmp_path: Path, version: int, name: str, sql: str) -> Path:
    """Real 0001_baseline.sql plus one synthetic migration, for adoption tests."""
    d = tmp_path / "with_later"
    d.mkdir()
    (d / "0001_baseline.sql").write_text((Path(schema_migrator.MIGRATIONS_DIR) / "0001_baseline.sql").read_text())
    _write(d, f"{version:04d}_{name}.sql", sql)
    return d


def _legacy_with_table(path: str, ddl: str) -> None:
    """A pre-migrator database that already holds an extra hand-built table."""
    make_legacy_db(path)
    raw = sqlite3.connect(path)
    raw.execute(ddl)
    raw.commit()
    raw.close()


SOLAR_DDL = "CREATE TABLE IF NOT EXISTS solar (id INTEGER PRIMARY KEY, name TEXT NOT NULL)"


def test_legacy_file_holding_a_later_migrations_table_is_adopted(tmp_path):
    path = str(tmp_path / "branchy.sqlite")
    _legacy_with_table(path, SOLAR_DDL)
    raw = sqlite3.connect(path)
    raw.execute("INSERT INTO solar (id, name) VALUES (1, 'kept')")
    raw.commit()
    raw.close()

    conn = sqlite3.connect(path)
    assert migrate(conn, db_path=path, directory=_baseline_plus(tmp_path, 2, "solar", SOLAR_DDL + ";\n")) == [1, 2]
    assert conn.execute("SELECT name FROM solar WHERE id=1").fetchone()[0] == "kept"
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    adopted = schema_migrator.history(conn)[0]
    assert adopted["kind"] == "adopted"
    assert "solar" in adopted["tables_touched"], "an adopted object must be recorded on the adoption row"


def test_legacy_file_with_an_undeclared_extra_table_is_still_refused(tmp_path):
    path = str(tmp_path / "rogue.sqlite")
    _legacy_with_table(path, "CREATE TABLE rogue (id INTEGER PRIMARY KEY)")

    with pytest.raises(SchemaError, match="unexpected table or index set: rogue"):
        initialize_db(path)


def test_legacy_file_with_a_declared_but_differently_shaped_table_is_refused(tmp_path):
    path = str(tmp_path / "mismatch.sqlite")
    _legacy_with_table(path, "CREATE TABLE solar (id INTEGER PRIMARY KEY, name TEXT NOT NULL, extra TEXT)")

    conn = sqlite3.connect(path)
    with pytest.raises(SchemaError, match="solar: present with a shape migration 0002 does not build"):
        migrate(conn, db_path=path, directory=_baseline_plus(tmp_path, 2, "solar", SOLAR_DDL + ";\n"))


def test_legacy_file_holding_a_table_its_migration_creates_unguarded_is_refused(tmp_path):
    path = str(tmp_path / "unguarded.sqlite")
    _legacy_with_table(path, SOLAR_DDL)

    conn = sqlite3.connect(path)
    with pytest.raises(SchemaError, match="without IF NOT EXISTS"):
        migrate(
            conn,
            db_path=path,
            directory=_baseline_plus(
                tmp_path, 2, "solar", "CREATE TABLE solar (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n"
            ),
        )


def test_legacy_file_already_holding_universe_candidate_adopts_and_migrates(tmp_path):
    """The real case: a database last opened on the opportunity-screener branch (ADR-032)."""
    path = str(tmp_path / "branch.sqlite")
    _legacy_with_table(
        path,
        """CREATE TABLE universe_candidate (
            ticker      TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            source      TEXT NOT NULL,
            asset_class TEXT,
            added_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
    )
    raw = sqlite3.connect(path)
    raw.execute("INSERT INTO universe_candidate (ticker, name, source) VALUES ('AAPL', 'Apple', 'Inc.')")
    raw.commit()
    raw.close()

    conn = initialize_db(path)
    assert [r[0] for r in conn.execute("SELECT version FROM schema_migrations ORDER BY version")] == [
        m.version for m in discover()
    ]
    assert conn.execute("SELECT name FROM universe_candidate WHERE ticker='AAPL'").fetchone()[0] == "Apple"
    assert conn.execute("PRAGMA user_version").fetchone()[0] == discover()[-1].version
