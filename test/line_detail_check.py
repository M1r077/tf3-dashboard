"""Mod rev 30 / schema 8: the lines section carries the terminal numbering only, the line detail file brings the rest
for one line. Checks the collector keeps the detail across later cycles, drops it when the station group changes, and
that schema 7 data (everything in the cycle) still overwrites as before. Uses a throw-away database."""
import json
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "collector"))
from collector import Store  # noqa: E402


def snap(seq, schema, stops):
    return {"schema": schema, "mod": "tf3_dashboard_export", "seq": seq, "slow_seq": seq, "real_time": 1_700_000_000 + seq, "player": 42,
            "errors": [], "time": {"game_time_ms": seq * 1000, "year": 1900, "month": 1, "day": 1 + seq, "lang": "en"},
            "finance": {"balance": 1}, "alerts": {}, "vehicles": [], "cargo_types": [{"id": 0, "name": "PASSENGERS"}],
            "company": {}, "stations": [], "towns": [], "industries": [], "depots": [],
            "lines": [{"id": 7, "name": "L", "stops": len(stops), "vehicles": 1, "capacity": [], "stop_list": stops}]}


def stop(group, terms, **kw):
    return {"station_group": group, "station": 0, "terminal": 0, "name": f"S{group}", "terminals": terms, "alternatives": [], **kw}


def numbering(n):
    return [{"n": i + 1, "station": 0, "terminal": i} for i in range(n)]


def row(store, i):
    r = store.con.execute("SELECT terminals, waiting FROM line_stop WHERE line_id=7 AND stop_index=?", (i,)).fetchone()
    return (json.loads(r["terminals"]) if r["terminals"] else None), (json.loads(r["waiting"]) if r["waiting"] else None)


def main() -> int:
    fails = []
    def check(cond, what):
        print(("ok   " if cond else "FAIL ") + what)
        if not cond:
            fails.append(what)

    with tempfile.TemporaryDirectory() as d:
        store = Store(Path(d) / "t.db")
        s1 = snap(1, 8, [stop(100, numbering(2)), stop(200, numbering(1))])
        store.ingest(s1)
        t, w = row(store, 1)
        check(t == numbering(2) and w is None, "schema 8 cycle: numbering only, no waiting")

        detail = {"item": {"line": 7, "stops": [
            {"stop_index": 1, "terminals": [{"n": 1, "station": 0, "terminal": 0, "pax": True, "cargo": False, "compatible": False, "overlength": True},
                                            {"n": 2, "station": 0, "terminal": 1, "pax": True, "cargo": False}],
             "waiting": [{"cargo_type": 0, "total": 12, "bad": 3}]},
            {"stop_index": 2, "terminals": [{"n": 1, "station": 0, "terminal": 0, "pax": False, "cargo": True}], "waiting": []}]}}
        check(store.ingest_line_detail(s1, detail) == 2, "line detail: 2 stops updated")
        t, w = row(store, 1)
        check(t[0].get("compatible") is False and t[0].get("overlength") is True and t[1].get("pax") is True, "detail fields merged")
        check(w == [{"cargo_type": 0, "total": 12, "bad": 3}], "waiting merged")

        # next cycle: same groups, one more terminal at stop 1 (station rebuilt with an extra platform)
        store.ingest(snap(2, 8, [stop(100, numbering(3)), stop(200, numbering(1))]))
        t, w = row(store, 1)
        check(len(t) == 3 and t[0].get("compatible") is False and t[2] == {"n": 3, "station": 0, "terminal": 2}, "detail kept across a cycle, new terminal bare")
        check(w == [{"cargo_type": 0, "total": 12, "bad": 3}], "waiting kept across a cycle")

        # a second detail for the same line must replace the first one's fields (compatible back to true, overlength gone)
        detail2 = {"item": {"line": 7, "stops": [
            {"stop_index": 1, "terminals": [{"n": 1, "station": 0, "terminal": 0, "pax": True, "cargo": False, "compatible": True},
                                            {"n": 2, "station": 0, "terminal": 1, "pax": True, "cargo": False}], "waiting": []}]}}
        store.ingest_line_detail(s1, detail2)
        t, w = row(store, 1)
        check(t[0].get("compatible") is True and "overlength" not in t[0], "second detail replaces the first")
        check(len(t) == 3 and t[2] == {"n": 3, "station": 0, "terminal": 2}, "second detail keeps the cycle's numbering")
        check(w is None, "waiting emptied by the second detail")

        # stop 1 now points at another station group: the old detail must not leak
        store.ingest(snap(3, 8, [stop(300, numbering(2)), stop(200, numbering(1))]))
        t, w = row(store, 1)
        check(t == numbering(2) and w is None, "group changed: detail dropped")
        t2, _ = row(store, 2)
        check(t2[0].get("cargo") is True, "other stop keeps its detail")

        # an older mod (schema 7) sends everything in the cycle: it overwrites, as before
        full = [{"n": 1, "station": 0, "terminal": 0, "pax": True, "cargo": False, "compatible": True}]
        store.ingest(snap(4, 7, [stop(300, full, waiting=[{"cargo_type": 0, "total": 1, "bad": 0}]), stop(200, full)]))
        t, w = row(store, 1)
        check(t == full and w == [{"cargo_type": 0, "total": 1, "bad": 0}], "schema 7: cycle overwrites")
        store.con.close()
    print(f"{len(fails)} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
