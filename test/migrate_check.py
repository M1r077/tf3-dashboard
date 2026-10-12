"""Migration check, run by build_release.py (no archive if it fails):

  python test\\migrate_check.py

For each old database in test/ (created by earlier companion versions), open it with the current Store (which runs
the migrations), ingest the recorded export in test/export/ (tf3dash_live.lua + tf3dash_slow_*.lua, mod schema 4),
and check that every table the export feeds received rows. Then do the same on a database created fresh from
schema.sql and check both end with the same columns.

This is what was missing in 0.6.1: a column added to schema.sql without its MIGRATIONS entry broke every slow insert
on existing databases for three releases, and only a test on an *old* database can catch that.
"""
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "collector"))
import collector  # noqa: E402

OLD_DBS = ["test/real.db", "test/test.db"]  # user_version 0, schema of 0.2-0.3
EXPORT = ROOT / "test" / "export" / "tf3dash_live.lua"
# tables the recorded export must fill (the slow part is what the 0.6.1 bug silently lost)
MUST_FILL = ["snapshot", "company", "finance", "vehicle", "vehicle_state", "line", "line_state", "line_stop",
             "station", "station_state", "town", "town_state", "industry", "industry_state", "depot", "cargo_type"]
CATALOGUE = {"vehicle", "line", "line_stop", "station", "town", "industry", "depot", "cargo_type", "company"}


def ingest(db: Path) -> dict[str, int]:
    store = collector.Store(db)
    snap = collector.read_live(EXPORT)
    assert snap and (snap.get("schema") or 1) >= 4, "test/export must be a schema >= 4 export"
    slow = collector.SlowFiles(EXPORT)
    slow.refresh()
    assert slow.complete_for(snap.get("slow_seq")), f"slow files incomplete for slow_seq {snap.get('slow_seq')}"
    snap = slow.merge(snap)
    before = {t: store.con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in MUST_FILL}
    store.ingest(snap)  # raises on any insert error: that is the point
    store.con.commit()
    after = {t: store.con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in MUST_FILL}
    cols = {t: [r[1] for r in store.con.execute(f"PRAGMA table_info({t})")]
            for (t,) in store.con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    store.con.close()
    # catalogue tables (line, town, ...) are upserted: an old recording of the same save already has the rows, so
    # count what is there afterwards; the *_state / snapshot tables must have grown
    rows = {t: (after[t] if t in CATALOGUE else after[t] - before[t]) for t in MUST_FILL}
    return rows, cols, store.added_columns


def line_lifecycle(db: Path) -> list[str]:
    """Lines renamed or deleted in game: the recorded export ingested again with one line renamed and one missing
    must update the name and mark the missing line gone (hidden from the lists, kept for the history's names). A
    cycle whose lines section failed in the mod, or whose file is missing, must not mark anything."""
    import copy
    store = collector.Store(db)
    slow = collector.SlowFiles(EXPORT)
    slow.refresh()
    base = slow.merge(collector.read_live(EXPORT))
    store.ingest(base)
    gid = store.con.execute("SELECT game_id FROM snapshot ORDER BY snapshot_id DESC LIMIT 1").fetchone()[0]
    lines = [l for l in base["lines"] if isinstance(l, dict)]
    assert len(lines) >= 2, "the recorded export needs two lines"
    renamed, deleted = lines[0]["id"], lines[1]["id"]

    def cycle(prev: dict) -> dict:  # the next slow cycle (a snapshot with the same seq/real_time is skipped as a duplicate)
        n = copy.deepcopy(base)
        n["slow_seq"] = (prev.get("slow_seq") or 0) + 1
        n["seq"] = (prev.get("seq") or 0) + 1
        n["real_time"] = (prev.get("real_time") or 0) + 60
        return n

    nxt = cycle(base)
    nxt["lines"] = [dict(l, name="Express") if l["id"] == renamed else l for l in lines if l["id"] != deleted]
    store.ingest(nxt)
    bad = []
    row = store.con.execute("SELECT name, gone FROM line WHERE game_id=? AND line_id=?", (gid, renamed)).fetchone()
    if row["name"] != "Express" or row["gone"] is not None:
        bad.append(f"renamed line: {dict(row)}")
    row = store.con.execute("SELECT name, gone FROM line WHERE game_id=? AND line_id=?", (gid, deleted)).fetchone()
    if row is None or row["gone"] is None:
        bad.append(f"deleted line not marked gone: {row and dict(row)}")
    if store.con.execute("SELECT COUNT(*) FROM line_stop WHERE game_id=? AND line_id=?", (gid, deleted)).fetchone()[0]:
        bad.append("deleted line still has stops")
    # a failed section must not touch the marks; the line comes back when exported again
    broken = cycle(nxt)
    broken["lines"], broken["errors"] = [], [{"section": "lines", "error": "boom"}]
    store.ingest(broken)
    if store.con.execute("SELECT COUNT(*) FROM line WHERE game_id=? AND gone IS NULL", (gid,)).fetchone()[0] != len(lines) - 1:
        bad.append("a failed lines section marked lines gone")
    back = cycle(broken)
    store.ingest(back)
    if store.con.execute("SELECT gone FROM line WHERE game_id=? AND line_id=?", (gid, deleted)).fetchone()[0] is not None:
        bad.append("re-exported line still gone")
    store.con.close()
    return bad


def main() -> int:
    failed = 0
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        bad = line_lifecycle(tmp / "lines.db")
        print("line lifecycle (rename, delete, failed section, back):", "FAIL " + "; ".join(bad) if bad else "ok")
        failed += bool(bad)
        fresh_rows, fresh_cols, _ = ingest(tmp / "fresh.db")
        print(f"fresh database: {sum(fresh_rows.values())} rows in {len(MUST_FILL)} tables")
        empty = [t for t, n in fresh_rows.items() if n == 0]
        if empty:
            print(f"  FAIL: the export fills nothing in {empty}")
            failed += 1
        for rel in OLD_DBS:
            src = ROOT / rel
            dst = tmp / Path(rel).name
            shutil.copy(src, dst)
            try:
                rows, cols, added = ingest(dst)
            except Exception as e:  # noqa: BLE001
                print(f"{rel}: FAIL: {e!r}")
                failed += 1
                continue
            bad = [t for t in MUST_FILL if rows[t] == 0 and fresh_rows[t] > 0]
            diff = {t: sorted(set(fresh_cols[t]) ^ set(cols.get(t, []))) for t in fresh_cols if set(fresh_cols[t]) != set(cols.get(t, []))}
            print(f"{rel}: {sum(rows.values())} rows ingested"
                  + (f", safety net added {added}" if added else "")
                  + (f"; FAIL no rows in {bad}" if bad else "")
                  + (f"; FAIL columns differ from a fresh database: {diff}" if diff else ""))
            if added:
                # the data got in, but only thanks to the safety net: the proper MIGRATIONS entry is missing
                print(f"  FAIL: add {added} to Store.MIGRATIONS")
            if bad or diff or added:
                failed += 1
    print("migrate_check:", "FAILED" if failed else "ok")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
