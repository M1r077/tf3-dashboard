"""TF3 Dashboard web server: serves the dashboard page and a JSON API over the SQLite database
filled by collector.py. Stdlib only.

    python server.py                 # http://localhost:8765
    python server.py --port 9000 --db D:/path/tf3_dashboard.db
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VERSION = "0.1.1"  # companion version (semver); build_release.cmd reads this line

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "collector"))
import tf3paths  # noqa: E402

DEFAULT_DB = tf3paths.DEFAULT_DB
STATIC = HERE / "static"

_local = threading.local()
DB_PATH: Path = DEFAULT_DB
# folder watched by the mod for dashboard -> game commands (same folder as live.lua); resolved in main()
CMD_DIR: Path | None = None
CMD_DISABLED = False
_cmd_lock = threading.Lock()
_cmd_seq = [int(__import__("time").time() * 1000) % 1_000_000_000]

# commands the mod accepts (mirror of COMMANDS in dashboard_export.script.lua) -> required args
ALLOWED_CMDS = {
    "set_speed": ("speed",), "pause": (), "toggle_pause": (), "ping": (),
    "focus_entity": ("entity",), "focus_position": ("x", "y"), "follow_entity": ("entity",),
    "select_entity": ("entity",), "open_line_manager": ("line",), "close_windows": (),
    "vehicle_stop": ("vehicle",), "vehicle_start": ("vehicle",), "vehicle_reverse": ("vehicle",),
    "vehicle_depart": ("vehicle",), "vehicle_to_depot": ("vehicle",),
    # lines (departure configuration of stops, whole-line vehicle actions, rename)
    "line_set_stop": ("line", "stop"), "line_set_all_stops": ("line",), "line_set_terminals": ("line", "stop", "main"),
    "line_stop_all": ("line",), "line_start_all": ("line",), "line_all_to_depot": ("line",),
    "rename_entity": ("entity", "name"),
}


def lua_literal(v) -> str:
    if v is None:
        return "nil"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return '"' + v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'
    if isinstance(v, dict):
        return "{ " + ", ".join(f"[{lua_literal(k)}] = {lua_literal(x)}" for k, x in v.items()) + " }"
    if isinstance(v, (list, tuple)):
        return "{ " + ", ".join(lua_literal(x) for x in v) + " }"
    raise TypeError(type(v))


def write_command(cmd: str, args: dict) -> dict:
    """Write cmd.lua for the mod. Returns {"id", "cmd"} or raises ValueError."""
    global CMD_DIR
    if CMD_DISABLED:
        raise ValueError("commands disabled (--no-cmd)")
    if CMD_DIR is None:
        CMD_DIR = tf3paths.export_dir()  # the game may have been started after the server
        if CMD_DIR is None:
            raise ValueError("Transport Fever 3 userdata folder not found (start the game with the mod once, or set export_dir in config.json)")
    if cmd not in ALLOWED_CMDS:
        raise ValueError(f"unknown command: {cmd}")
    for k in ALLOWED_CMDS[cmd]:
        if k not in args:
            raise ValueError(f"missing argument: {k}")
    clean = {}
    for k, v in args.items():
        if isinstance(v, (int, float, bool)) or v is None:
            clean[k] = v
        elif isinstance(v, str) and len(v) < 200:
            clean[k] = v
        elif isinstance(v, list) and len(v) <= 64 and all(isinstance(x, (int, float)) for x in v):
            clean[k] = v
        elif isinstance(v, dict) and len(v) <= 8 and all(isinstance(x, (int, float)) and isinstance(kk, str) for kk, x in v.items()):
            clean[k] = v  # e.g. main = {station, terminal}
        elif isinstance(v, list) and len(v) <= 64 and all(isinstance(x, dict) and len(x) <= 8 and all(isinstance(y, (int, float)) and isinstance(kk, str) for kk, y in x.items()) for x in v):
            clean[k] = v  # e.g. alternatives = [{station, terminal}, ...]
    with _cmd_lock:
        _cmd_seq[0] += 1
        cid = _cmd_seq[0]
        body = "function data()\nreturn " + lua_literal({"id": cid, "cmd": cmd, "args": clean}) + "\nend\n"
        CMD_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CMD_DIR / "cmd.lua.tmp"
        tmp.write_text(body, encoding="utf-8")
        tmp.replace(CMD_DIR / "cmd.lua")  # atomic rename: the mod never sees a half-written file
    return {"id": cid, "cmd": cmd}


def db() -> sqlite3.Connection:
    con = getattr(_local, "con", None)
    if con is None:
        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
        con.row_factory = sqlite3.Row
        _local.con = con
    return con


def rows(sql: str, args: tuple = ()) -> list[dict]:
    out = []
    for r in db().execute(sql, args):
        d = dict(r)
        for k, v in d.items():
            if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                d[k] = None
        out.append(d)
    return out


def one(sql: str, args: tuple = ()) -> dict | None:
    r = rows(sql, args)
    return r[0] if r else None


# ---------------------------------------------------------------- API
def api_overview(q: dict) -> dict:
    snap = one("SELECT * FROM snapshot ORDER BY snapshot_id DESC LIMIT 1")
    if not snap:
        return {"empty": True, "version": VERSION}
    sid = snap["snapshot_id"]
    gid = snap["game_id"]
    fin = one("SELECT * FROM finance WHERE snapshot_id=?", (sid,)) or {}
    comp = one("SELECT c.* FROM company c JOIN snapshot s USING(snapshot_id) WHERE s.game_id=? ORDER BY snapshot_id DESC LIMIT 1", (gid,)) or {}
    prev = one("""SELECT f.balance, s.real_time FROM finance f JOIN snapshot s USING(snapshot_id)
                  WHERE s.game_id=? AND s.snapshot_id < ? ORDER BY s.snapshot_id DESC LIMIT 1 OFFSET 29""", (gid, sid))
    veh = one("""SELECT COUNT(*) n, SUM(vs.state='EN_ROUTE') en_route, SUM(vs.state='AT_TERMINAL') at_terminal,
                 SUM(vs.state='IN_DEPOT') in_depot, SUM(vs.state='GOING_TO_DEPOT') to_depot, SUM(vs.no_path) no_path,
                 SUM(vs.user_stopped) stopped, SUM(vs.load) load, SUM(v.capacity) capacity, AVG(vs.maintenance) maint,
                 SUM(vs.maintenance < 0.5) worn
                 FROM vehicle_state vs JOIN vehicle v ON v.vehicle_id=vs.vehicle_id AND v.game_id=? WHERE vs.snapshot_id=?""", (gid, sid)) or {}
    alerts = rows("SELECT kind, COUNT(*) n FROM alert WHERE snapshot_id=? GROUP BY kind", (sid,))
    errors = rows("SELECT section, error FROM snapshot_error WHERE snapshot_id=?", (sid,))
    game = one("SELECT * FROM game WHERE game_id=?", (gid,))
    ack = None
    if snap.get("cmd_ack"):
        try:
            ack = json.loads(snap["cmd_ack"])
        except ValueError:
            ack = None
    pending = (CMD_DIR / "cmd.lua").exists() if CMD_DIR else False
    return {"snapshot": snap, "finance": fin, "company": comp, "vehicles": veh, "alerts": alerts, "errors": errors,
            "game": game, "balance_prev": prev, "lang": (game or {}).get("lang"), "version": VERSION,
            "commands": {"enabled": not CMD_DISABLED, "accepted": snap.get("accept_commands"), "ack": ack, "pending": pending}}


def api_finance(q: dict) -> dict:
    limit = _limit(q, 600)
    gid = _gid()
    rng = _range(q)
    series = _merged_series(
        gid, rng, limit,
        detail_sql="""SELECT snapshot_id, real_time, game_time_ms, year, month, day, balance, loan, earnings_ytd,
                      passengers_transported, cargo_transported FROM v_finance_series WHERE game_id=? AND real_time >= ?
                      ORDER BY snapshot_id DESC LIMIT ?""",
        agg_sql="""SELECT bucket, n, game_time_ms, year, month, day, balance, loan, earnings_ytd, passengers_transported, cargo_transported
                   FROM agg_finance_min WHERE game_id=? AND bucket >= ? ORDER BY bucket""")
    comp = rows("""SELECT s.snapshot_id, s.real_time, s.year, c.total_score, c.total_assets, c.debt, c.number_of_lines,
                   c.total_stations, c.rail_vehicles + c.trams + c.road_vehicles + c.aircrafts + c.ships AS vehicles
                   FROM company c JOIN snapshot s USING(snapshot_id) WHERE s.game_id=? ORDER BY s.snapshot_id DESC LIMIT 200""", (gid,))
    comp.reverse()
    return {"series": series, "company": comp}


def api_alerts(q: dict) -> dict:
    snap = one("SELECT snapshot_id FROM snapshot ORDER BY snapshot_id DESC LIMIT 1")
    if not snap:
        return {"alerts": []}
    sid = snap["snapshot_id"]
    gid = _gid()
    al = rows("""SELECT a.*, 
                 COALESCE(l.name, v.name, t.name, i.name, '') AS entity_name
                 FROM alert a
                 LEFT JOIN line l ON l.game_id=? AND l.line_id=a.entity_id AND a.kind IN ('line_problem','line_issue')
                 LEFT JOIN vehicle v ON v.game_id=? AND v.vehicle_id=a.entity_id AND a.kind IN ('vehicle_problem','blocked_train','no_path_vehicle')
                 LEFT JOIN town t ON t.game_id=? AND t.town_id=a.entity_id AND a.kind='town_problem'
                 LEFT JOIN industry i ON i.game_id=? AND i.industry_id=a.entity_id AND a.kind='closing_industry'
                 WHERE a.snapshot_id=? ORDER BY a.kind, entity_name""", (gid, gid, gid, gid, sid))
    # how long each alert has been present (consecutive snapshots)
    hist = rows("""SELECT kind, entity_id, COUNT(DISTINCT snapshot_id) n, MIN(s.real_time) since
                   FROM alert a JOIN snapshot s USING(snapshot_id)
                   WHERE s.game_id=? AND s.snapshot_id > (SELECT COALESCE(MAX(snapshot_id),0) FROM snapshot WHERE game_id=?) - 300
                   GROUP BY kind, entity_id""", (gid, gid))
    hmap = {(h["kind"], h["entity_id"]): h for h in hist}
    for a in al:
        h = hmap.get((a["kind"], a["entity_id"]))
        a["seen"] = h["n"] if h else 1
        a["since"] = h["since"] if h else None
    return {"alerts": al}


def api_lines(q: dict) -> dict:
    gid = _gid()
    lines = rows("""SELECT l.line_id, l.name, l.color_r, l.color_g, l.color_b, l.transport_modes, l.custom_filters, l.reservation_priority, ls.*
                    FROM line l JOIN line_state ls ON ls.line_id=l.line_id
                    WHERE l.game_id=? AND ls.snapshot_id=(SELECT MAX(snapshot_id) FROM line_state x WHERE x.line_id=l.line_id)
                    ORDER BY l.name""", (gid,))
    sid_by_line = {l["line_id"]: l["snapshot_id"] for l in lines}
    caps = rows("""SELECT lc.line_id, lc.cargo_id, ct.name AS cargo, ct.key AS cargo_key, lc.used, lc.capacity
                   FROM line_capacity lc LEFT JOIN cargo_type ct ON ct.game_id=? AND ct.cargo_id=lc.cargo_id
                   WHERE lc.snapshot_id IN (SELECT MAX(snapshot_id) FROM line_capacity GROUP BY line_id)""", (gid,))
    veh = rows("""SELECT vs.line_id, COUNT(*) n, SUM(vs.load) load, AVG(vs.speed_ms) speed, SUM(vs.state='EN_ROUTE') en_route,
                         GROUP_CONCAT(DISTINCT v.carrier) carriers, GROUP_CONCAT(DISTINCT v.icon_type) icon_types
                  FROM vehicle_state vs LEFT JOIN vehicle v ON v.game_id=? AND v.vehicle_id=vs.vehicle_id
                  WHERE vs.snapshot_id=(SELECT MAX(snapshot_id) FROM vehicle_state) GROUP BY vs.line_id""", (gid,))
    vmap = {v["line_id"]: v for v in veh}
    stops = rows("""SELECT line_id, stop_index, name, station_group, station, terminal, load_mode, min_wait, max_wait, max_add_wait, waypoints,
                           force_unload, destroy_for_config_change, destroy_for_refresh, no_load, max_load, terminals, alternatives
                    FROM line_stop WHERE game_id=? ORDER BY line_id, stop_index""", (gid,))
    for st in stops:
        for k in ("no_load", "max_load", "terminals", "alternatives"):
            try:
                st[k] = json.loads(st[k]) if st.get(k) else []
            except (TypeError, ValueError):
                st[k] = []
    smap: dict[int, list] = {}
    stmap: dict[int, list] = {}
    for s in stops:
        smap.setdefault(s["line_id"], []).append(s["name"])
        stmap.setdefault(s["line_id"], []).append(s)
    cmap: dict[int, list] = {}
    for c in caps:
        if sid_by_line.get(c["line_id"]):
            cmap.setdefault(c["line_id"], []).append(c)
    for l in lines:
        l["live"] = vmap.get(l["line_id"])
        l["stop_names"] = smap.get(l["line_id"], [])
        l["stop_list"] = stmap.get(l["line_id"], [])
        l["capacities"] = cmap.get(l["line_id"], [])
    cargo_types = rows("SELECT cargo_id, name, key FROM cargo_type WHERE game_id=? ORDER BY cargo_id", (gid,))
    return {"lines": lines, "cargo_types": cargo_types}


def api_line_history(q: dict) -> dict:
    lid = int(q["id"][0])
    gid = _gid()
    hist = rows("""SELECT s.real_time, s.year, s.month, ls.vehicles, ls.persons_on_line, ls.pax_bad, ls.pax_total, ls.cargo_bad, ls.cargo_total,
                   ls.max_frequency FROM line_state ls JOIN snapshot s USING(snapshot_id)
                   WHERE s.game_id=? AND s.real_time >= ? AND ls.line_id=? ORDER BY s.snapshot_id DESC LIMIT ?""", (gid, _since_iso(q), lid, _limit(q, 300)))
    hist.reverse()
    _stamp(hist)
    # vehicles currently assigned to this line (latest snapshot) with the name of their next stop
    veh = rows("""SELECT v.vehicle_id, v.name, v.carrier, v.icon_type, v.model, v.model_key, v.parts, v.capacity, vs.state, vs.speed_ms, vs.load, vs.maintenance,
                  vs.stop_index, vs.no_path, vs.user_stopped, vs.days_in_depot, vs.days_at_terminal, st.name AS stop_name
                  FROM vehicle v JOIN vehicle_state vs ON vs.vehicle_id=v.vehicle_id
                  LEFT JOIN line_stop st ON st.game_id=v.game_id AND st.line_id=vs.line_id AND st.stop_index=vs.stop_index+1  -- game stopIndex is 0-based, line_stop is 1-based
                  WHERE v.game_id=? AND vs.line_id=? AND vs.snapshot_id=(SELECT MAX(snapshot_id) FROM vehicle_state)
                  ORDER BY vs.stop_index, v.name""", (gid, lid))
    return {"history": hist, "vehicles": veh}


def api_fleet(q: dict) -> dict:
    """Fleet overview: counts by carrier/state, fill rate, worn vehicles, idle vehicles, recent history."""
    gid = _gid()
    sid = one("SELECT MAX(snapshot_id) sid FROM vehicle_state")
    sid = sid["sid"] if sid else None
    if sid is None:
        return {"empty": True}
    by_carrier = rows("""SELECT v.carrier, COUNT(*) n, SUM(vs.state='EN_ROUTE') en_route, SUM(vs.state='AT_TERMINAL') at_terminal,
                         SUM(vs.state='IN_DEPOT') in_depot, SUM(vs.state='GOING_TO_DEPOT') to_depot,
                         SUM(vs.load) load, SUM(v.capacity) capacity, AVG(vs.maintenance) maint, SUM(vs.maintenance < 0.5) worn,
                         SUM(vs.no_path) no_path, SUM(vs.user_stopped) stopped, SUM(vs.running_cost) running_cost, SUM(vs.value) value,
                         AVG(CASE WHEN vs.state='EN_ROUTE' THEN vs.speed_ms END) avg_speed,
                         SUM(CASE WHEN vs.state='EN_ROUTE' AND vs.speed_ms < 0.5 THEN 1 ELSE 0 END) stuck
                         FROM vehicle_state vs JOIN vehicle v ON v.vehicle_id=vs.vehicle_id AND v.game_id=?
                         WHERE vs.snapshot_id=? GROUP BY v.carrier ORDER BY n DESC""", (gid, sid))
    worn = rows("""SELECT v.vehicle_id, v.name, v.carrier, v.icon_type, vs.maintenance, vs.value, vs.running_cost, l.name AS line_name
                   FROM vehicle_state vs JOIN vehicle v ON v.vehicle_id=vs.vehicle_id AND v.game_id=?
                   LEFT JOIN line l ON l.game_id=? AND l.line_id=vs.line_id
                   WHERE vs.snapshot_id=? AND vs.maintenance IS NOT NULL ORDER BY vs.maintenance ASC LIMIT 12""", (gid, gid, sid))
    idle = rows("""SELECT v.vehicle_id, v.name, v.carrier, v.icon_type, vs.state, vs.days_in_depot, vs.days_at_terminal, vs.user_stopped, vs.no_path, l.name AS line_name
                   FROM vehicle_state vs JOIN vehicle v ON v.vehicle_id=vs.vehicle_id AND v.game_id=?
                   LEFT JOIN line l ON l.game_id=? AND l.line_id=vs.line_id
                   WHERE vs.snapshot_id=? AND (vs.days_in_depot + vs.days_at_terminal > 2 OR vs.no_path = 1 OR vs.user_stopped = 1 OR vs.line_id IS NULL OR vs.line_id = 0)
                   ORDER BY vs.no_path DESC, vs.days_in_depot + vs.days_at_terminal DESC LIMIT 15""", (gid, gid, sid))
    # stuck: EN_ROUTE but speed ~0 for the last N snapshots
    stuck = rows("""SELECT v.vehicle_id, v.name, v.carrier, v.icon_type, l.name AS line_name, COUNT(*) n, MAX(vs.x) x, MAX(vs.y) y
                    FROM vehicle_state vs JOIN vehicle v ON v.vehicle_id=vs.vehicle_id AND v.game_id=?
                    LEFT JOIN line l ON l.game_id=? AND l.line_id=vs.line_id
                    WHERE vs.snapshot_id > ? - 15 AND vs.state='EN_ROUTE' AND vs.speed_ms < 0.3
                    GROUP BY v.vehicle_id HAVING n >= 10 ORDER BY n DESC LIMIT 15""", (gid, gid, sid))
    rng = _range(q)
    hist = _merged_series(
        gid, rng, _limit(q, 400),
        detail_sql="""SELECT s.snapshot_id, s.real_time, s.year, s.month, s.day,
                      SUM(vs.state='EN_ROUTE') en_route, SUM(vs.state='AT_TERMINAL') at_terminal, SUM(vs.state='IN_DEPOT') in_depot,
                      SUM(vs.load) load, SUM(v.capacity) capacity, AVG(CASE WHEN vs.state='EN_ROUTE' THEN vs.speed_ms END) avg_speed, AVG(vs.maintenance) maint
                      FROM vehicle_state vs JOIN snapshot s USING(snapshot_id) JOIN vehicle v ON v.game_id=s.game_id AND v.vehicle_id=vs.vehicle_id
                      WHERE s.game_id=? AND s.real_time >= ?
                      GROUP BY s.snapshot_id ORDER BY s.snapshot_id DESC LIMIT ?""",
        agg_sql="""SELECT bucket, n, year, month, day, en_route, at_terminal, in_depot, load, capacity, avg_speed, maint
                   FROM agg_fleet_min WHERE game_id=? AND bucket >= ? ORDER BY bucket""")
    caps = rows("""SELECT SUM(v.capacity) capacity FROM vehicle_state vs JOIN vehicle v ON v.vehicle_id=vs.vehicle_id AND v.game_id=? WHERE vs.snapshot_id=?""", (gid, sid))
    return {"by_carrier": by_carrier, "worn": worn, "idle": idle, "stuck": stuck, "history": hist, "capacity": caps[0]["capacity"] if caps else None, "range": rng}


def api_vehicle_history(q: dict) -> dict:
    vid = int(q["id"][0])
    gid = _gid()
    rng = _range(q)
    hist = _merged_series(
        gid, rng, _limit(q, 300),
        detail_sql="""SELECT s.real_time, s.year, s.month, s.day, vs.state, vs.speed_ms, vs.load, vs.maintenance, vs.x, vs.y, vs.line_id, vs.stop_index
                      FROM vehicle_state vs JOIN snapshot s USING(snapshot_id) WHERE s.game_id=? AND s.real_time >= ? AND vs.vehicle_id=?
                      ORDER BY s.snapshot_id DESC LIMIT ?""",
        agg_sql="""SELECT bucket, n, year, month, day, state, speed_ms, load, maintenance, x, y, line_id, stop_index
                   FROM agg_vehicle_min WHERE game_id=? AND bucket >= ? AND vehicle_id=? ORDER BY bucket""",
        extra=(vid,))
    v = one("SELECT v.*, l.name AS line_name FROM vehicle v LEFT JOIN vehicle_state vs ON vs.vehicle_id=v.vehicle_id AND vs.snapshot_id=(SELECT MAX(snapshot_id) FROM vehicle_state x WHERE x.vehicle_id=v.vehicle_id) LEFT JOIN line l ON l.game_id=v.game_id AND l.line_id=vs.line_id WHERE v.game_id=? AND v.vehicle_id=?", (gid, vid))
    return {"vehicle": v, "history": hist}


def api_vehicles(q: dict) -> dict:
    gid = _gid()
    veh = rows("""SELECT v.vehicle_id, v.name, v.carrier, v.capacity, v.icon_type, v.model, v.model_key, v.parts, vs.*, l.name AS line_name, t.name AS town_name
                  FROM vehicle v JOIN vehicle_state vs ON vs.vehicle_id=v.vehicle_id
                  LEFT JOIN line l ON l.game_id=v.game_id AND l.line_id=vs.line_id
                  LEFT JOIN town t ON t.game_id=v.game_id AND t.town_id=vs.closest_town
                  WHERE v.game_id=? AND vs.snapshot_id=(SELECT MAX(snapshot_id) FROM vehicle_state)
                  ORDER BY v.carrier, l.name, v.name""", (gid,))
    return {"vehicles": veh}


def api_towns(q: dict) -> dict:
    gid = _gid()
    towns = rows("""SELECT t.town_id, t.name, t.x, t.y, ts.* FROM town t JOIN town_state ts ON ts.town_id=t.town_id
                    WHERE t.game_id=? AND ts.snapshot_id=(SELECT MAX(snapshot_id) FROM town_state x WHERE x.town_id=t.town_id)
                    ORDER BY (COALESCE(ts.cap_res,0)+COALESCE(ts.cap_com,0)+COALESCE(ts.cap_ind,0)) DESC""", (gid,))
    cargo = rows("""SELECT tc.town_id, tc.cargo_id, ct.name AS cargo, ct.key AS cargo_key, tc.stock, tc.capacity
                    FROM town_cargo tc LEFT JOIN cargo_type ct ON ct.game_id=? AND ct.cargo_id=tc.cargo_id
                    WHERE tc.snapshot_id=(SELECT MAX(snapshot_id) FROM town_cargo)""", (gid,))
    cmap: dict[int, list] = {}
    for c in cargo:
        cmap.setdefault(c["town_id"], []).append(c)
    # "supplied / needed" of the town window (mod schema 3+), whole town only (land_use 0); per land use stays in the DB
    supply = rows("""SELECT town_id, cargo_id, v1, v2, v3 FROM town_supply
                     WHERE land_use=0 AND snapshot_id=(SELECT MAX(snapshot_id) FROM town_supply)""")
    smap: dict[tuple, dict] = {(s["town_id"], s["cargo_id"]): s for s in supply}
    for c in cargo:
        s = smap.get((c["town_id"], c["cargo_id"]))
        c["supplied"] = s["v1"] if s else None
        c["needed"] = s["v2"] if s else None
        c["supply_v3"] = s["v3"] if s else None
    top = rows("""SELECT tl.town_id, tl.line_id, l.name, tl.resident_unhappy, tl.resident_total, tl.nonresident_unhappy, tl.nonresident_total
                  FROM town_top_line tl LEFT JOIN line l ON l.game_id=? AND l.line_id=tl.line_id
                  WHERE tl.snapshot_id=(SELECT MAX(snapshot_id) FROM town_top_line)""", (gid,))
    tmap: dict[int, list] = {}
    for t in top:
        tmap.setdefault(t["town_id"], []).append(t)
    for t in towns:
        t["cargo"] = cmap.get(t["town_id"], [])
        t["top_lines"] = tmap.get(t["town_id"], [])
    return {"towns": towns}


def api_town_history(q: dict) -> dict:
    tid = int(q["id"][0])
    gid = _gid()
    hist = rows("""SELECT s.real_time, s.year, s.month, ts.cap_res, ts.cap_com, ts.cap_ind, ts.used_res, ts.used_com, ts.used_ind,
                   ts.hap_inside_unhappy, ts.hap_inside_total, ts.line_usage, ts.noise_db, ts.pollution_db, ts.traffic_speed
                   FROM town_state ts JOIN snapshot s USING(snapshot_id) WHERE s.game_id=? AND s.real_time >= ? AND ts.town_id=? ORDER BY s.snapshot_id DESC LIMIT ?""", (gid, _since_iso(q), tid, _limit(q, 300)))
    hist.reverse()
    _stamp(hist)
    return {"history": hist}


def api_industries(q: dict) -> dict:
    gid = _gid()
    inds = rows("""SELECT i.industry_id, i.name, i.construction, i.max_level, i.x, i.y, st.* FROM industry i
                   JOIN industry_state st ON st.industry_id=i.industry_id
                   WHERE i.game_id=? AND st.snapshot_id=(SELECT MAX(snapshot_id) FROM industry_state x WHERE x.industry_id=i.industry_id)
                   ORDER BY i.name""", (gid,))
    cargo = rows("""SELECT ic.*, ct.name AS cargo, ct.key AS cargo_key FROM industry_cargo ic LEFT JOIN cargo_type ct ON ct.game_id=? AND ct.cargo_id=ic.cargo_id
                    WHERE ic.snapshot_id=(SELECT MAX(snapshot_id) FROM industry_cargo)""", (gid,))
    cmap: dict[int, list] = {}
    for c in cargo:
        cmap.setdefault(c["industry_id"], []).append(c)
    for i in inds:
        i["cargo"] = cmap.get(i["industry_id"], [])
    return {"industries": inds}


def api_stations(q: dict) -> dict:
    gid = _gid()
    st = rows("""SELECT s.station_id, s.name, s.is_cargo, s.x, s.y, s.construction, t.name AS town_name, ss.*
                 FROM station s JOIN station_state ss ON ss.station_id=s.station_id
                 LEFT JOIN town t ON t.game_id=s.game_id AND t.town_id=s.town_id
                 WHERE s.game_id=? AND ss.snapshot_id=(SELECT MAX(snapshot_id) FROM station_state x WHERE x.station_id=s.station_id)
                 ORDER BY ss.used DESC""", (gid,))
    return {"stations": st}


def api_depots(q: dict) -> dict:
    gid = _gid()
    d = rows("""SELECT d.depot_id, d.name, d.carrier, ds.* FROM depot d JOIN depot_state ds ON ds.depot_id=d.depot_id
                WHERE d.game_id=? AND ds.snapshot_id=(SELECT MAX(snapshot_id) FROM depot_state x WHERE x.depot_id=d.depot_id)""", (gid,))
    return {"depots": d}


def api_map(q: dict) -> dict:
    gid = _gid()
    sid = one("SELECT MAX(snapshot_id) sid FROM vehicle_state")
    sid = sid["sid"] if sid else None
    veh = rows("""SELECT v.vehicle_id, v.name, v.carrier, v.icon_type, v.model_key, vs.x, vs.y, vs.speed_ms, vs.state, vs.line_id, vs.load, v.capacity,
                  l.color_r, l.color_g, l.color_b, l.name AS line_name
                  FROM vehicle_state vs JOIN vehicle v ON v.vehicle_id=vs.vehicle_id AND v.game_id=?
                  LEFT JOIN line l ON l.game_id=? AND l.line_id=vs.line_id
                  WHERE vs.snapshot_id=? AND vs.x IS NOT NULL""", (gid, gid, sid)) if sid else []
    towns = rows("""SELECT t.town_id, t.name, t.x, t.y, ts.cap_res+ts.cap_com+ts.cap_ind AS size FROM town t
                    LEFT JOIN town_state ts ON ts.town_id=t.town_id AND ts.snapshot_id=(SELECT MAX(snapshot_id) FROM town_state x WHERE x.town_id=t.town_id)
                    WHERE t.game_id=? AND t.x IS NOT NULL""", (gid,))
    st = rows("SELECT station_id, name, x, y, is_cargo FROM station WHERE game_id=? AND x IS NOT NULL", (gid,))
    ind = rows("SELECT industry_id, name, x, y FROM industry WHERE game_id=? AND x IS NOT NULL", (gid,))
    # alerts with position
    al = rows("SELECT kind, entity_id, x, y FROM alert WHERE snapshot_id=(SELECT MAX(snapshot_id) FROM snapshot) AND x IS NOT NULL")
    # line paths: stops -> station group -> station position (first station of the group with coordinates)
    paths = rows("""SELECT ls.line_id, ls.stop_index, l.name, l.color_r, l.color_g, l.color_b,
                           COALESCE(s1.x, s2.x) AS x, COALESCE(s1.y, s2.y) AS y
                    FROM line_stop ls
                    JOIN line l ON l.game_id=ls.game_id AND l.line_id=ls.line_id
                    LEFT JOIN station s1 ON s1.game_id=ls.game_id AND s1.station_id=ls.station_group
                    LEFT JOIN station s2 ON s2.game_id=ls.game_id AND s2.station_group=ls.station_group
                        AND s2.station_id=(SELECT MIN(station_id) FROM station x WHERE x.game_id=ls.game_id AND x.station_group=ls.station_group AND x.x IS NOT NULL)
                    WHERE ls.game_id=? ORDER BY ls.line_id, ls.stop_index""", (gid,))
    lines: dict[int, dict] = {}
    for p in paths:
        d = lines.setdefault(p["line_id"], {"line_id": p["line_id"], "name": p["name"], "color_r": p["color_r"], "color_g": p["color_g"], "color_b": p["color_b"], "points": []})
        if p["x"] is not None:
            d["points"].append([p["x"], p["y"]])
    return {"vehicles": veh, "towns": towns, "stations": st, "industries": ind, "alerts": al, "lines": list(lines.values())}


DETAIL_FETCH_CAP = 20000  # 2 h at 2 s = 3600 rows per series; generous bound for the SQL
RANGES = {"5m": 300, "10m": 600, "15m": 900, "20m": 1200, "30m": 1800, "45m": 2700, "1h": 3600, "all": 0}


def _range(q: dict) -> str:
    r = q.get("range", ["all"])[0]
    return r if r in RANGES else "all"


def _epoch(iso_str: str) -> float:
    return datetime.datetime.fromisoformat(iso_str).timestamp()


def _since_iso(q: dict) -> str:
    secs = RANGES.get(_range(q), 0)
    return datetime.datetime.fromtimestamp(time.time() - secs).isoformat(timespec="seconds") if secs else "0000"


def _stamp(hist: list[dict]) -> None:
    for h in hist:
        h["ts"] = _epoch(h["real_time"])
        h["agg"] = 0


def _merged_series(gid: int, rng: str, limit: int, detail_sql: str, agg_sql: str, extra: tuple = ()) -> list[dict]:
    """Time series = per-minute aggregates (older) + per-snapshot detail (recent), both inside the range.
    Every row gets `ts` (unix seconds) and `agg` (0 = detail, 60 = one-minute bucket).
    `limit` bounds the number of detail rows (most recent first) and, when the result is still too dense,
    the detail part is thinned to roughly `limit` points so the browser never gets more than it can draw."""
    secs = RANGES.get(rng, 0)
    since_ts = time.time() - secs if secs else 0
    since_iso = datetime.datetime.fromtimestamp(since_ts).isoformat(timespec="seconds") if secs else "0000"
    # fetch the whole detail window (bounded by the collector's retention, ~2 h) and thin afterwards,
    # so the aggregate/detail boundary never shows a hole
    detail = rows(detail_sql, (gid, since_iso) + extra + (DETAIL_FETCH_CAP,))
    detail.reverse()
    for d in detail:
        d["ts"] = _epoch(d["real_time"])
        d["agg"] = 0
    if len(detail) > limit:
        step = len(detail) / limit
        detail = [detail[int(i * step)] for i in range(limit)] + [detail[-1]]
    first_detail_ts = detail[0]["ts"] if detail else time.time()
    agg = rows(agg_sql, (gid, int(since_ts // 60) * 60 if secs else 0) + extra)
    out = []
    for a in agg:
        if a["bucket"] + 60 > first_detail_ts:  # overlap: detail wins
            continue
        a["ts"] = a["bucket"]
        a["agg"] = 60
        a["real_time"] = datetime.datetime.fromtimestamp(a["bucket"]).isoformat(timespec="seconds")
        out.append(a)
    out.extend(detail)
    return out


def _limit(q: dict, default: int, cap: int = 5000) -> int:
    try:
        return max(10, min(cap, int(q.get("limit", [default])[0])))
    except (TypeError, ValueError):
        return default


def _gid() -> int:
    r = one("SELECT game_id FROM snapshot ORDER BY snapshot_id DESC LIMIT 1")
    return r["game_id"] if r else -1


ROUTES = {
    "/api/overview": api_overview, "/api/finance": api_finance, "/api/alerts": api_alerts, "/api/lines": api_lines,
    "/api/line_history": api_line_history, "/api/vehicles": api_vehicles, "/api/fleet": api_fleet, "/api/vehicle_history": api_vehicle_history, "/api/towns": api_towns,
    "/api/town_history": api_town_history, "/api/industries": api_industries, "/api/stations": api_stations,
    "/api/depots": api_depots, "/api/map": api_map,
}

MIME = {".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon"}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quieter
        if "/api/" not in (args[0] if args else ""):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ROUTES:
            try:
                data = ROUTES[u.path](parse_qs(u.query))
                self._send(200, json.dumps(data, default=str).encode("utf-8"), "application/json; charset=utf-8")
            except sqlite3.OperationalError as e:
                self._send(503, json.dumps({"error": str(e)}).encode(), "application/json")
            except Exception as e:  # noqa: BLE001
                self._send(500, json.dumps({"error": repr(e)}).encode(), "application/json")
            return
        path = "index.html" if u.path in ("/", "") else u.path.lstrip("/")
        f = (STATIC / path).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            self._send(404, b"not found", "text/plain")
            return
        self._send(200, f.read_bytes(), MIME.get(f.suffix, "application/octet-stream"))

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/api/cmd":
            self._send(404, b"not found", "text/plain")
            return
        # local only: never accept commands from another host
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self._send(403, json.dumps({"error": "local only"}).encode(), "application/json")
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            res = write_command(str(body.get("cmd", "")), body.get("args") or {})
            self._send(200, json.dumps({"ok": True, **res}).encode(), "application/json; charset=utf-8")
        except (ValueError, TypeError) as e:
            self._send(400, json.dumps({"ok": False, "error": str(e)}).encode(), "application/json; charset=utf-8")
        except OSError as e:
            self._send(500, json.dumps({"ok": False, "error": str(e)}).encode(), "application/json; charset=utf-8")


def main(argv=None) -> int:
    global DB_PATH, CMD_DIR, CMD_DISABLED
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", type=Path, default=None, help="SQLite database (default: db/tf3_dashboard.db or config.json)")
    ap.add_argument("--port", type=int, default=None, help="HTTP port (default: 8765 or config.json)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--cmd-dir", type=Path, default=None, help="folder where cmd.lua is written for the mod (default: auto-detect)")
    ap.add_argument("--no-cmd", action="store_true", help="disable dashboard -> game commands")
    args = ap.parse_args(argv)
    DB_PATH = tf3paths.db_path(args.db)
    port = tf3paths.port(args.port)
    CMD_DISABLED = bool(args.no_cmd)
    CMD_DIR = None if CMD_DISABLED else tf3paths.export_dir(args.cmd_dir)
    if not DB_PATH.exists():
        print(f"database not found: {DB_PATH} (start collector.py first)", file=sys.stderr)
    srv = ThreadingHTTPServer((args.host, port), Handler)
    print(f"TF3 dashboard {VERSION}: http://{args.host}:{port}/   db={DB_PATH}", flush=True)
    if not CMD_DISABLED:
        print(f"commands -> {CMD_DIR or '(game folder not found yet, will retry on first command)'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
