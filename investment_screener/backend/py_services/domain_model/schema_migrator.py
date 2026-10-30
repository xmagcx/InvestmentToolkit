"""The ONLY code that creates or changes domain_model.sqlite tables.

Schema lives in numbered SQL files under `investment_screener/backend/schema/domain_model/`
(`0001_baseline.sql`, `0002_<name>.sql`, ...). Each file is applied once, inside one
transaction, and recorded in the `schema_migrations` table with a checksum. The newest
applied version is also stored in `PRAGMA user_version` so other processes (the Node
backend) can verify they are talking to a compatible schema without parsing anything.

Rules
-----
* Applied migration files are immutable: an edited file fails the checksum check.
* Add a column/table/index by adding the next numbered file. Never edit an old one.
* Node code does not create or alter tables. It checks `user_version` and fails loudly.
* A populated database is backed up (`db_backup`, label `pre-migration-NNNN`) before any
  pending migration runs.
* A database created before this system existed (tables present, no ledger) is first
  self-healed with the retired additive column list, then compared against the baseline,
  and stamped as version 1 only if they match. A mismatch raises `SchemaError` and the
  file is left untouched.

Migration files must explain themselves. The FIRST line is a comment giving the file's
number, name and a plain-English description of what changes and why:

    -- 0002_valuation_model: add valuation_model to sub_strategy so the DCF skill can choose
    -- the landlord, neocloud or operating-company method (further comment lines welcome).

`discover()` rejects a file without one. Each application is written to `schema_migrations`
as a version history: description, when, by whom, from which git commit, how long it took,
which tables it touched (detected from the SQL), the backup that protects it, and whether it
was applied fresh or adopted from a database that pre-dated the migrator.

CLI:  python3 schema_migrator.py [--db PATH] [--status | --history [--json]]
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

try:  # imported as part of the `domain_model` package
    from .db_backup import backup_database
except ImportError:  # run as a script
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from db_backup import backup_database  # type: ignore[no-redef]

MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "schema" / "domain_model"
_FILE_RE = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")
# The version history. One row per migration, written in the same transaction that applies it.
# Columns after `applied_at` are metadata for people; only version/name/checksum are enforced.
_LEDGER_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version         INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    kind            TEXT NOT NULL DEFAULT 'applied',
    checksum        TEXT NOT NULL,
    applied_at      TEXT NOT NULL,
    applied_by      TEXT,
    git_commit      TEXT,
    duration_ms     INTEGER,
    tables_touched  TEXT,
    backup_file     TEXT
);
"""
_LEDGER_COLUMNS = {
    "description": "TEXT NOT NULL DEFAULT ''",
    "kind": "TEXT NOT NULL DEFAULT 'applied'",
    "applied_by": "TEXT",
    "git_commit": "TEXT",
    "duration_ms": "INTEGER",
    "tables_touched": "TEXT",
    "backup_file": "TEXT",
}
_MIN_DESCRIPTION = 15

# Retired: the additive column list that used to be patched in on every open. Kept only so
# a database file created before the migrator existed can be healed to the baseline shape
# before it is verified and stamped. New columns go in numbered migrations instead.
_LEGACY_ADDITIVE_COLUMNS: dict[str, list[tuple[str, str]]] = {
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


class SchemaError(RuntimeError):
    """The database and the migration files disagree in a way that needs a human."""


@dataclass(frozen=True)
class Migration:
    version: int
    name: str
    description: str
    sql: str
    checksum: str
    tables: tuple[str, ...]


_HEADER_RE = re.compile(r"^--\s*(?:(\d{4})_([a-z0-9_]+)\s*:\s*)?(.*\S)\s*$")
_TABLE_REFS = [
    re.compile(p, re.I)
    for p in (
        r"\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"`]?(\w+)",
        r"\bALTER\s+TABLE\s+[\"`]?(\w+)",
        r"\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\"`]?(\w+)",
        r"\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\w+\s+ON\s+[\"`]?(\w+)",
        r"\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+[\"`]?(\w+)",
        r"\bUPDATE\s+[\"`]?(\w+)\s+SET\b",
        r"\bDELETE\s+FROM\s+[\"`]?(\w+)",
    )
]


def _describe(filename: str, version: int, name: str, text: str) -> str:
    """The required one-line description from the file's first line."""
    first = next((ln for ln in text.split("\n") if ln.strip()), "")
    match = _HEADER_RE.match(first) if first.startswith("--") else None
    if not match:
        raise SchemaError(
            f"{filename}: the first line must be a comment describing the change, e.g.\n"
            f"  -- {version:04d}_{name}: what changes and why, in plain English"
        )
    if match.group(1) and (int(match.group(1)), match.group(2)) != (version, name):
        raise SchemaError(
            f"{filename}: header says {match.group(1)}_{match.group(2)} but the file is {version:04d}_{name}"
        )
    description = match.group(3).strip()
    if len(description) < _MIN_DESCRIPTION:
        raise SchemaError(
            f"{filename}: description {description!r} is too short (need at least "
            f"{_MIN_DESCRIPTION} characters). Say what changes and why."
        )
    return description


def _tables_touched(sql: str) -> tuple[str, ...]:
    code = "\n".join(ln for ln in sql.split("\n") if not ln.lstrip().startswith("--"))
    found = {m.group(1) for rx in _TABLE_REFS for m in rx.finditer(code)}
    return tuple(sorted(found - {"schema_migrations"}))


def discover(directory: Path | None = None) -> list[Migration]:
    """Load migration files, validating names, descriptions, contiguity (1..N) and uniqueness."""
    directory = directory or MIGRATIONS_DIR
    found: list[Migration] = []
    for path in sorted(directory.glob("*.sql")):
        match = _FILE_RE.match(path.name)
        if not match:
            raise SchemaError(f"migration file {path.name!r} must be named NNNN_snake_case.sql")
        text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
        version, name = int(match.group(1)), match.group(2)
        found.append(
            Migration(
                version=version,
                name=name,
                description=_describe(path.name, version, name, text),
                sql=text,
                checksum=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                tables=_tables_touched(text),
            )
        )
    versions = [m.version for m in found]
    if versions != list(range(1, len(versions) + 1)):
        raise SchemaError(f"migration versions must be contiguous from 0001; found {versions}")
    return found


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    return (
        conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
        is not None
    )


def _user_tables(conn: sqlite3.Connection) -> list[str]:
    return [
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'"
        )
    ]


def _fingerprint(conn: sqlite3.Connection) -> dict:
    """Structure that must match between two databases: columns, FKs and indexes."""
    shape: dict = {}
    for table in _user_tables(conn):
        cols = {
            r[1]: (r[2].upper(), r[3], r[4], r[5])
            for r in conn.execute(f'PRAGMA table_info("{table}")')
        }
        fks = sorted((r[2], r[3], r[4]) for r in conn.execute(f'PRAGMA foreign_key_list("{table}")'))
        shape[table] = {"columns": cols, "foreign_keys": fks}
    shape["__indexes__"] = sorted(
        (r[0], r[1])
        for r in conn.execute(
            "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'"
        )
    )
    return shape


def _diff(expected: dict, actual: dict) -> list[str]:
    problems: list[str] = []
    for table in sorted(set(expected) | set(actual)):
        if table not in actual:
            problems.append(f"missing table or index set: {table}")
        elif table not in expected:
            problems.append(f"unexpected table or index set: {table}")
        elif expected[table] != actual[table]:
            if table == "__indexes__":
                problems.append(f"indexes differ: expected {expected[table]}, found {actual[table]}")
                continue
            e, a = expected[table], actual[table]
            for col in sorted(set(e["columns"]) | set(a["columns"])):
                if e["columns"].get(col) != a["columns"].get(col):
                    problems.append(
                        f"{table}.{col}: expected {e['columns'].get(col)}, found {a['columns'].get(col)}"
                    )
            if e["foreign_keys"] != a["foreign_keys"]:
                problems.append(f"{table}: foreign keys differ")
    return problems


def _expected_fingerprint(migrations: list[Migration], up_to: int) -> dict:
    scratch = sqlite3.connect(":memory:")
    try:
        for m in migrations:
            if m.version <= up_to:
                scratch.executescript(m.sql)
        return _fingerprint(scratch)
    finally:
        scratch.close()


_CREATE_RE = re.compile(r"^\s*CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", re.I)
# The same CREATE carrying the IF NOT EXISTS guard. Re-running a guarded CREATE over an object
# that already exists is a no-op, which is what lets an adopting database keep such an object
# and still apply the migration that declares it.
_GUARDED_CREATE_RE = re.compile(
    r"^\s*CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+[\"`]?(\w+)", re.I
)


def _statements(sql: str) -> list[str]:
    """Split a SQL script into complete statements (comments and blanks dropped)."""
    out, buf = [], ""
    for line in sql.split("\n"):
        if not buf and (not line.strip() or line.lstrip().startswith("--")):
            continue
        buf += line + "\n"
        if sqlite3.complete_statement(buf):
            out.append(buf.strip())
            buf = ""
    return out


def _declared_by_later_migrations(migrations: list[Migration], after: int) -> dict[str, tuple[int, bool]]:
    """Object name -> (first later migration that creates it, whether that CREATE is guarded)."""
    declared: dict[str, tuple[int, bool]] = {}
    for m in migrations:
        if m.version <= after:
            continue
        for stmt in _statements(m.sql):
            guarded = _GUARDED_CREATE_RE.match(stmt)
            if guarded:
                declared.setdefault(guarded.group(2), (m.version, True))
                continue
            plain = _CREATE_RE.match(stmt)
            if plain:
                declared.setdefault(plain.group(2), (m.version, False))
    return declared


def _adoption_tolerances(
    migrations: list[Migration], actual: dict, baseline: dict, after: int
) -> tuple[set[str], set[tuple[str, str]], list[str]]:
    """Objects an adopting database may already hold, plus the reasons it may not hold them.

    A database written before this ledger existed can legitimately contain an object a *later*
    migration declares: a feature branch built it by hand in `db_client.py` before the schema
    became migration-owned. Keeping that object is safe only when the migration that creates it
    is guarded with IF NOT EXISTS and the live shape is exactly what that migration builds, so
    applying it afterwards cannot fail and cannot silently change the file. Anything else is
    drift and still refuses adoption.
    """
    declared = _declared_by_later_migrations(migrations, after)
    baseline_indexes = {tuple(pair) for pair in baseline["__indexes__"]}
    tables: set[str] = set()
    indexes: set[tuple[str, str]] = set()
    problems: list[str] = []
    expected_cache: dict[int, dict] = {}

    def expected_at(in_: int) -> dict:
        if in_ not in expected_cache:
            expected_cache[in_] = _expected_fingerprint(migrations, in_)
        return expected_cache[in_]

    def verdict(name: str, table: str | None = None) -> str | None:
        """None when `name` can be kept as found, otherwise the problem with it."""
        spec = declared.get(name)
        if spec is None:
            return f"unexpected table or index set: {name}"
        version, guarded = spec
        if not guarded:
            return (
                f"{name}: migration {version:04d} creates it without IF NOT EXISTS, so this "
                "database cannot keep the copy it already holds; guard that CREATE"
            )
        if table is None:
            return None  # shape is compared by the caller
        if (name, table) not in {tuple(pair) for pair in expected_at(version)["__indexes__"]}:
            return f"{name}: migration {version:04d} does not create it on {table}"
        return None

    for name, shape in actual.items():
        if name == "__indexes__":
            continue
        if name in baseline:
            if baseline[name] != shape:
                problems.append(f"{name}: present with a shape 0001_baseline.sql does not build")
            continue
        problem = verdict(name)
        if problem:
            problems.append(problem)
        elif expected_at(declared[name][0])[name] != shape:
            problems.append(
                f"{name}: present with a shape migration {declared[name][0]:04d} does not build"
            )
        else:
            tables.add(name)

    for pair in map(tuple, actual["__indexes__"]):
        if pair in baseline_indexes:
            continue
        problem = verdict(pair[0], table=pair[1])
        if problem:
            problems.append(problem)
        else:
            indexes.add(pair)

    return tables, indexes, problems


def _prune_fingerprint(shape: dict, tables: set[str], indexes: set[tuple[str, str]]) -> dict:
    """`shape` without the tolerated objects, so the baseline diff stops at real drift only."""
    pruned: dict = {}
    for name, value in shape.items():
        if name == "__indexes__":
            pruned[name] = [pair for pair in value if tuple(pair) not in indexes]
        elif name not in tables:
            pruned[name] = value
    return pruned


def _create_missing_from_baseline(conn: sqlite3.Connection, baseline_sql: str) -> None:
    """Old files lack tables added in later waves; create exactly those, as the retired
    `CREATE TABLE IF NOT EXISTS` code did. Existing objects are never touched."""
    existing = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    for stmt in _statements(baseline_sql):
        match = _CREATE_RE.match(stmt)
        if match and match.group(2) not in existing:
            conn.execute(stmt)
            existing.add(match.group(2))


def _legacy_self_heal(conn: sqlite3.Connection) -> None:
    for table, columns in _LEGACY_ADDITIVE_COLUMNS.items():
        if not _has_table(conn, table):
            continue
        existing = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}
        for column, col_type in columns:
            if column not in existing:
                conn.execute(f'ALTER TABLE "{table}" ADD COLUMN {column} {col_type};')


def _ensure_ledger(conn: sqlite3.Connection) -> None:
    """Create the version-history table, or add any metadata column an older ledger lacks."""
    conn.execute(_LEDGER_DDL)
    existing = {r[1] for r in conn.execute("PRAGMA table_info(schema_migrations)")}
    for column, ddl in _LEDGER_COLUMNS.items():
        if column not in existing:
            conn.execute(f"ALTER TABLE schema_migrations ADD COLUMN {column} {ddl}")


def _git_commit() -> str | None:
    """Short commit of the code doing the migrating; best effort, never an error."""
    try:
        out = subprocess.run(
            ["git", "-C", str(MIGRATIONS_DIR), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=3,
        )
        return out.stdout.strip() or None if out.returncode == 0 else None
    except Exception:
        return None


def _applied_by() -> str | None:
    try:
        return getpass.getuser()
    except Exception:
        return None


def _record(
    conn: sqlite3.Connection,
    m: Migration,
    *,
    kind: str,
    started: float,
    backup_file: str | Path | None = None,
    also_tables: tuple[str, ...] = (),
) -> None:
    conn.execute(
        "INSERT INTO schema_migrations (version, name, description, kind, checksum, applied_at, "
        "applied_by, git_commit, duration_ms, tables_touched, backup_file) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            m.version, m.name, m.description, kind, m.checksum,
            datetime.now(timezone.utc).isoformat(), _applied_by(), _git_commit(),
            int((time.monotonic() - started) * 1000),
            ", ".join(sorted(set(m.tables) | set(also_tables))),
            str(backup_file) if backup_file else None,
        ),
    )


def history(conn: sqlite3.Connection) -> list[dict]:
    """The recorded version history, oldest first. Empty if the ledger does not exist yet."""
    if not _has_table(conn, "schema_migrations"):
        return []
    conn.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM schema_migrations ORDER BY version")]
    finally:
        conn.row_factory = None


def current_version(conn: sqlite3.Connection) -> int:
    if not _has_table(conn, "schema_migrations"):
        return 0
    row = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
    return row[0] or 0


def migrate(
    conn: sqlite3.Connection,
    *,
    db_path: str | Path | None = None,
    directory: Path | None = None,
    backup: bool = True,
) -> list[int]:
    """Bring `conn`'s database to the newest schema. Returns the versions applied/stamped.

    `db_path` is needed (and used) only to take the pre-migration backup of a populated,
    file-backed database; in-memory databases are never backed up.
    """
    migrations = discover(directory)
    # The ledger is created only once there is something to record, so refusing to adopt a
    # drifted file really does leave it byte-for-byte as found.
    ledger = (
        {
            r[0]: (r[1], r[2])
            for r in conn.execute("SELECT version, name, checksum FROM schema_migrations")
        }
        if _has_table(conn, "schema_migrations")
        else {}
    )
    by_version = {m.version: m for m in migrations}
    for version, (_name, checksum) in sorted(ledger.items()):
        known = by_version.get(version)
        if known is None:
            raise SchemaError(
                f"database is at migration {version} but no such file exists here: "
                "this checkout is older than the database"
            )
        if known.checksum != checksum:
            raise SchemaError(
                f"migration {version:04d}_{known.name}.sql was edited after it was applied "
                "(checksum mismatch). Restore the file and add a new migration instead."
            )

    done: list[int] = []
    populated = bool(_user_tables(conn))

    if not ledger and populated:
        # Created before the migrator existed. Heal, verify, then adopt as the baseline,
        # all in one transaction: a refusal leaves the file exactly as it was found.
        started = time.monotonic()
        conn.execute("BEGIN IMMEDIATE")
        try:
            _create_missing_from_baseline(conn, migrations[0].sql)
            _legacy_self_heal(conn)
            baseline = _expected_fingerprint(migrations, migrations[0].version)
            actual = _fingerprint(conn)
            kept, kept_indexes, problems = _adoption_tolerances(
                migrations, actual, baseline, migrations[0].version
            )
            problems = problems or _diff(baseline, _prune_fingerprint(actual, kept, kept_indexes))
            if problems:
                raise SchemaError(
                    "existing database does not match 0001_baseline.sql; refusing to adopt it "
                    "(nothing was changed):\n  " + "\n  ".join(problems)
                )
            _ensure_ledger(conn)
            _record(
                conn,
                migrations[0],
                kind="adopted",
                started=started,
                also_tables=tuple(sorted(kept)),
            )
            conn.execute(f"PRAGMA user_version = {migrations[0].version}")
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        ledger[1] = (migrations[0].name, migrations[0].checksum)
        done.append(1)

    pending = [m for m in migrations if m.version not in ledger]
    backup_file: Path | None = None
    if pending and populated and backup and db_path and str(db_path) != ":memory:":
        backup_file = backup_database(db_path, label=f"pre-migration-{pending[0].version:04d}")

    if pending:
        _ensure_ledger(conn)
        conn.commit()

    for m in pending:
        started = time.monotonic()
        try:
            # No COMMIT in the script: the transaction stays open so the migration, its
            # history row and the new user_version land together or not at all.
            conn.executescript("BEGIN IMMEDIATE;\n" + m.sql)
            _record(conn, m, kind="applied", started=started, backup_file=backup_file)
            conn.execute(f"PRAGMA user_version = {m.version}")
            conn.commit()
        except Exception as exc:
            if conn.in_transaction:
                conn.rollback()
            raise SchemaError(f"migration {m.version:04d}_{m.name}.sql failed and was rolled back: {exc}") from exc
        done.append(m.version)

    return done


def _format_history(rows: list[dict]) -> str:
    if not rows:
        return "no version history recorded yet (database has not been migrated)"
    lines = []
    for r in rows:
        lines += [
            f"{r['version']:04d}  {r['name']}  [{r['kind']}]",
            f"      {r['description']}",
            f"      applied {r['applied_at']} by {r['applied_by'] or '?'}"
            f" from commit {r['git_commit'] or '?'} in {r['duration_ms'] if r['duration_ms'] is not None else '?'} ms",
            f"      tables: {r['tables_touched'] or '-'}",
            f"      backup: {r['backup_file'] or '-'}",
            f"      checksum: {r['checksum'][:12]}",
            "",
        ]
    return "\n".join(lines).rstrip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Apply pending domain_model schema migrations.")
    parser.add_argument(
        "--db",
        default=str(Path(__file__).resolve().parents[2] / "data" / "domain_model.sqlite"),
    )
    parser.add_argument("--status", action="store_true", help="show version and pending, change nothing")
    parser.add_argument("--history", action="store_true", help="show the recorded version history, change nothing")
    parser.add_argument("--json", action="store_true", help="with --history: machine-readable output")
    args = parser.parse_args(argv)

    try:
        migrations = discover()
    except SchemaError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.status or args.history:
        conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        try:
            at = current_version(conn)
            rows = history(conn)
        finally:
            conn.close()
        if args.history:
            print(json.dumps(rows, indent=2) if args.json else _format_history(rows))
            return 0
        pending = [m for m in migrations if m.version > at]
        print(f"database at version {at}; newest available {migrations[-1].version}")
        if pending:
            print("pending:")
            for m in pending:
                print(f"  {m.version:04d}_{m.name}: {m.description}")
        else:
            print("pending: none")
        return 0

    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        applied = migrate(conn, db_path=args.db)
    except SchemaError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    print(f"applied: {applied}" if applied else "schema already up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
