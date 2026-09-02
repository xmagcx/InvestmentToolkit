"""
test_ingest_universe_csv.py — RED phase tests for universe CSV ingestion.

Tests cover: _split_source dual-format, header validation, empty CSV,
ticker normalization, duplicate skip, empty/whitespace ticker rejection,
source field whitespace trimming, and CLI JSON output contract.
"""
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
BACKEND_DIR = REPO_ROOT / "investment_screener" / "backend"
SCRIPT_DIR = BACKEND_DIR / "py_services"
INGEST_SCRIPT = SCRIPT_DIR / "ingest_universe_csv.py"

sys.path.insert(0, str(SCRIPT_DIR))

VALID_3COL_HEADER = "ticker,name,source"


# ---------------------------------------------------------------------------
# Helper: run ingest_universe_csv.py against a tmp DB
# ---------------------------------------------------------------------------
def _run_ingest(csv_text: str, db_path: str, *, dry_run: bool = False) -> dict:
    """Run ingest_universe_csv.py CLI and return parsed JSON output."""
    args = [sys.executable, str(INGEST_SCRIPT),
            "--payload", csv_text, "--db-path", db_path]
    if dry_run:
        args.append("--dry-run")
    result = subprocess.run(args, capture_output=True, text=True,
                            cwd=str(SCRIPT_DIR))
    assert result.returncode == 0, (
        f"ingest_universe_csv.py exited {result.returncode}\n"
        f"STDOUT: {result.stdout}\nSTDERR: {result.stderr}"
    )
    import json
    return json.loads(result.stdout)


# ---------------------------------------------------------------------------
# _split_source dual-format
# ---------------------------------------------------------------------------
class TestSplitSource:
    """_split_source must handle bare source and asset_class,source formats."""

    def test_bare_source_sets_asset_class_none(self):
        from ingest_universe_csv import _split_source
        source, asset_class = _split_source("RACIONAL")
        assert source == "RACIONAL"
        assert asset_class is None

    def test_asset_class_and_source_comma_separated(self):
        from ingest_universe_csv import _split_source
        source, asset_class = _split_source("EQUITY,RACIONAL")
        assert source == "RACIONAL"
        assert asset_class == "EQUITY"

    def test_source_with_extra_segments_uses_first_two(self):
        from ingest_universe_csv import _split_source
        source, asset_class = _split_source("BOND,FIXED_INCOME,RACIONAL")
        assert source == "FIXED_INCOME"
        assert asset_class == "BOND"

    def test_empty_source_returns_empty_and_none(self):
        from ingest_universe_csv import _split_source
        source, asset_class = _split_source("")
        assert source == ""
        assert asset_class is None

    def test_whitespace_only_source_returns_stripped(self):
        from ingest_universe_csv import _split_source
        source, asset_class = _split_source("  RACIONAL  ")
        assert source == "RACIONAL"
        assert asset_class is None


# ---------------------------------------------------------------------------
# Header validation
# ---------------------------------------------------------------------------
class TestHeaderValidation:
    """CSV must have exactly ticker,name,source headers."""

    def test_wrong_header_rejected(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = "sym,company,broker\nAAPL,Apple Inc,BROKER1\n"
        with pytest.raises(ValueError, match="mismatch"):
            parse_csv_text(csv_text, db_path="/tmp/should-not-exist.sqlite")

    def test_valid_3col_header_accepted(self):
        """Valid header does not raise — rows may still be empty."""
        from ingest_universe_csv import parse_csv_text
        csv_text = f"{VALID_3COL_HEADER}\n"
        result = parse_csv_text(csv_text, db_path="/tmp/test-empty.sqlite")
        assert result["inserted"] == 0

    def test_two_column_header_rejected(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = "ticker,name\nAAPL,Apple Inc\n"
        with pytest.raises(ValueError, match="mismatch"):
            parse_csv_text(csv_text, db_path="/tmp/should-not-exist.sqlite")


# ---------------------------------------------------------------------------
# Empty CSV handling
# ---------------------------------------------------------------------------
class TestEmptyCsv:
    """Empty CSV (header only, no data rows) should return 0 inserted."""

    def test_header_only_returns_zero_inserted(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = f"{VALID_3COL_HEADER}\n"
        result = parse_csv_text(csv_text, db_path="/tmp/test-empty.sqlite")
        assert result["inserted"] == 0
        assert result["skipped"] == 0
        assert result["errors"] == []

    def test_completely_empty_string_returns_zero(self):
        from ingest_universe_csv import parse_csv_text
        result = parse_csv_text("", db_path="/tmp/test-empty.sqlite")
        assert result["inserted"] == 0


# ---------------------------------------------------------------------------
# Ticker normalization
# ---------------------------------------------------------------------------
class TestTickerNormalization:
    """Tickers must be normalized via ticker_aliases.normalize_ticker."""

    def test_psu_u_to_normalized_to_psu_u_to(self):
        """PSU.U.TO should normalize to PSU-U.TO before insert."""
        from ingest_universe_csv import parse_csv_text
        csv_text = f"{VALID_3COL_HEADER}\nPSU.U.TO,Power Corp,RACIONAL\n"
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            result = parse_csv_text(csv_text, db_path=db_path)
            assert result["inserted"] == 1
            from domain_model.universe_repository import list_universe_candidates
            from domain_model.db_client import initialize_db
            conn = initialize_db(db_path)
            rows = list_universe_candidates(conn)
            assert len(rows) == 1
            assert rows[0]["ticker"] == "PSU-U.TO"

    def test_already_normalized_ticker_unchanged(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = f"{VALID_3COL_HEADER}\nAAPL,Apple Inc,RACIONAL\n"
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            result = parse_csv_text(csv_text, db_path=db_path)
            assert result["inserted"] == 1
            from domain_model.universe_repository import list_universe_candidates
            from domain_model.db_client import initialize_db
            conn = initialize_db(db_path)
            rows = list_universe_candidates(conn)
            assert rows[0]["ticker"] == "AAPL"


# ---------------------------------------------------------------------------
# Duplicate ticker skip
# ---------------------------------------------------------------------------
class TestDuplicateSkip:
    """Re-uploading existing tickers must skip (not fail), report counts."""

    def test_existing_ticker_skipped_new_inserted(self):
        from ingest_universe_csv import parse_csv_text
        csv_round1 = f"{VALID_3COL_HEADER}\nAAPL,Apple Inc,RACIONAL\nMSFT,Microsoft,RACIONAL\n"
        csv_round2 = f"{VALID_3COL_HEADER}\nAAPL,Apple Inc,RACIONAL\nGOOG,Alphabet,RACIONAL\n"
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            r1 = parse_csv_text(csv_round1, db_path=db_path)
            assert r1["inserted"] == 2
            assert r1["skipped"] == 0
            r2 = parse_csv_text(csv_round2, db_path=db_path)
            assert r2["inserted"] == 1
            assert r2["skipped"] == 1
            from domain_model.universe_repository import list_universe_candidates
            from domain_model.db_client import initialize_db
            conn = initialize_db(db_path)
            rows = list_universe_candidates(conn)
            tickers = {r["ticker"] for r in rows}
            assert tickers == {"AAPL", "MSFT", "GOOG"}


# ---------------------------------------------------------------------------
# Empty / whitespace ticker rejection
# ---------------------------------------------------------------------------
class TestEmptyTickerRejection:
    """Rows with empty or whitespace-only tickers must be rejected."""

    def test_whitespace_ticker_rejected(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = f"{VALID_3COL_HEADER}\n  ,Whitespace Co,RACIONAL\n"
        result = parse_csv_text(csv_text, db_path="/tmp/test-ws.sqlite")
        assert result["inserted"] == 0
        assert len(result["errors"]) >= 1

    def test_empty_ticker_rejected(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = f"{VALID_3COL_HEADER}\n,Empty Ticker,RACIONAL\n"
        result = parse_csv_text(csv_text, db_path="/tmp/test-empty-ticker.sqlite")
        assert result["inserted"] == 0
        assert len(result["errors"]) >= 1

    def test_mixed_valid_and_invalid_inserts_valid_only(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = (
            f"{VALID_3COL_HEADER}\n"
            f"AAPL,Apple Inc,RACIONAL\n"
            f"  ,Whitespace Co,RACIONAL\n"
            f"MSFT,Microsoft,RACIONAL\n"
        )
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            result = parse_csv_text(csv_text, db_path=db_path)
            assert result["inserted"] == 2
            assert len(result["errors"]) == 1
            from domain_model.universe_repository import list_universe_candidates
            from domain_model.db_client import initialize_db
            conn = initialize_db(db_path)
            rows = list_universe_candidates(conn)
            tickers = {r["ticker"] for r in rows}
            assert tickers == {"AAPL", "MSFT"}


# ---------------------------------------------------------------------------
# Source field whitespace trimming
# ---------------------------------------------------------------------------
class TestSourceFieldTrimming:
    """Source field values should be stripped of surrounding whitespace."""

    def test_source_whitespace_trimmed(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = f"{VALID_3COL_HEADER}\nAAPL,Apple Inc,  RACIONAL  \n"
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            result = parse_csv_text(csv_text, db_path=db_path)
            assert result["inserted"] == 1
            from domain_model.universe_repository import list_universe_candidates
            from domain_model.db_client import initialize_db
            conn = initialize_db(db_path)
            rows = list_universe_candidates(conn)
            assert rows[0]["source"] == "RACIONAL"


# ---------------------------------------------------------------------------
# Asset class default when absent
# ---------------------------------------------------------------------------
class TestAssetClassDefault:
    """When source field has no comma, asset_class defaults to NULL."""

    def test_bare_source_sets_asset_class_none(self):
        from ingest_universe_csv import parse_csv_text
        csv_text = f"{VALID_3COL_HEADER}\nAAPL,Apple Inc,RACIONAL\n"
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            parse_csv_text(csv_text, db_path=db_path)
            from domain_model.universe_repository import list_universe_candidates
            from domain_model.db_client import initialize_db
            conn = initialize_db(db_path)
            rows = list_universe_candidates(conn)
            assert rows[0]["asset_class"] is None

    def test_comma_source_sets_asset_class(self):
        from ingest_universe_csv import parse_csv_text
        # Source containing a comma must be quoted as a single CSV field.
        csv_text = f'{VALID_3COL_HEADER}\nAAPL,Apple Inc,"EQUITY,RACIONAL"\n'
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            parse_csv_text(csv_text, db_path=db_path)
            from domain_model.universe_repository import list_universe_candidates
            from domain_model.db_client import initialize_db
            conn = initialize_db(db_path)
            rows = list_universe_candidates(conn)
            assert rows[0]["asset_class"] == "EQUITY"
            assert rows[0]["source"] == "RACIONAL"


# ---------------------------------------------------------------------------
# CLI JSON output contract
# ---------------------------------------------------------------------------
class TestCliJsonOutput:
    """CLI must output JSON with inserted/skipped/errors keys."""

    def test_cli_success_json_output(self):
        csv_text = f"{VALID_3COL_HEADER}\nAAPL,Apple Inc,RACIONAL\n"
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            result = _run_ingest(csv_text, db_path)
            assert "inserted" in result
            assert "skipped" in result
            assert "errors" in result
            assert result["inserted"] == 1

    def test_cli_empty_csv_json_output(self):
        csv_text = f"{VALID_3COL_HEADER}\n"
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            result = _run_ingest(csv_text, db_path)
            assert result["inserted"] == 0
            assert result["skipped"] == 0
            assert result["errors"] == []

    def test_cli_dry_run_does_not_persist(self):
        csv_text = f"{VALID_3COL_HEADER}\nAAPL,Apple Inc,RACIONAL\n"
        import tempfile, os
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "test.sqlite")
            result = _run_ingest(csv_text, db_path, dry_run=True)
            assert result["inserted"] == 1
            from domain_model.universe_repository import list_universe_candidates
            from domain_model.db_client import initialize_db
            conn = initialize_db(db_path)
            rows = list_universe_candidates(conn)
            assert len(rows) == 0
