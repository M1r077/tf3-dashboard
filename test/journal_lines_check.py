"""Per-line finance in tf3dash_journal.lua: the rev 31 string format ({xs = "...", ys = "..."}) and the older
point-table format ({x, y, label} per point) give the same rows in line_finance.

    python test/journal_lines_check.py
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "collector"))
import collector  # noqa: E402

XS = [326, 327, 328, 329]
INCOME = [0, 1368991, 1420978, 675831]
COST = [0, 120000, 130500, 99000]


def journal(fmt: str) -> dict:
    if fmt == "old":
        series = [[[x, y, "1/1/1981"] for x, y in zip(XS, ys)] for ys in (INCOME, COST)]
    else:
        series = [{"xs": ",".join(map(str, XS)), "ys": ",".join(map(str, ys)), "n": len(XS)} for ys in (INCOME, COST)]
    return {"journal": {"game_time_ms": 498103400, "year": 1981, "lines": [{"id": 338235, "series": series, "x_markers": [], "groups": 16}]}}


def rows_for(fmt: str) -> list:
    import tempfile
    store = collector.Store(Path(tempfile.mkdtemp()) / f"journal_{fmt}.db")
    snap = {"schema": 8, "mod": "tf3_dashboard_export", "game": {"id": "test"}, "time": {"game_time_ms": 498103400}}
    store.ingest_journal(snap, journal(fmt))
    return [tuple(r) for r in store.con.execute(
        "SELECT line_id, series, idx, x, amount FROM line_finance ORDER BY line_id, series, idx").fetchall()]


old, new = rows_for("old"), rows_for("new")
assert len(new) == 8, new
assert old == new, (old, new)
print("ok: rev 31 strings and the old point tables give the same", len(new), "rows")
