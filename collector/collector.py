"""TF3 Dashboard collector: watches <userdata>/towns_industries/tf3dash_live.lua written by the
tf3_dashboard_export mod, parses it and stores everything in a SQLite database.

Usage:
    python collector.py                       # watch, default paths
    python collector.py --once                # import the current file once and exit
    python collector.py --db D:/path/tf3.db --live "C:/.../towns_industries/tf3dash_live.lua"
    python collector.py --status              # print a short summary of the database

No third-party dependency (stdlib only).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import console  # noqa: E402
import luatable  # noqa: E402
import tf3paths  # noqa: E402

VERSION = tf3paths.version()
SCHEMA_SQL = Path(__file__).resolve().parent / "schema.sql"
ERROR_LOG = tf3paths.ROOT / "db" / "collector_errors.log"


def iso(ts: float | None = None) -> str:
    return dt.datetime.fromtimestamp(ts if ts is not None else time.time()).isoformat(timespec="seconds")


def g(d: Any, *keys: str, default: Any = None) -> Any:
    """Safe nested get on dict/list parsed from Lua."""
    cur = d
    for k in keys:
        if isinstance(cur, dict):
            cur = cur.get(k)
        else:
            return default
        if cur is None:
            return default
    return cur


def b(v: Any) -> int | None:
    if v is None:
        return None
    return 1 if v else 0


def xyz(p: Any) -> tuple[Any, Any, Any]:
    if isinstance(p, dict):
        return p.get("x"), p.get("y"), p.get("z")
    return None, None, None


def clean_enum(v: Any) -> Any:
    """The mod writes tostring(value) for unknown enum values -> "nil" means unknown."""
    if v in (None, "nil", ""):
        return None
    return v


def hz_to_headway(hz: Any) -> float | None:
    """Game reports line frequency in Hz (departures per second); store seconds between departures."""
    try:
        hz = float(hz)
    except (TypeError, ValueError):
        return None
    if hz <= 0:
        return None
    return 1.0 / hz


def _epoch(iso_str: str) -> float:
    """ISO local time (as written by iso()) -> unix seconds."""
    return dt.datetime.fromisoformat(iso_str).timestamp()


def _local_offset() -> int:
    """Seconds to subtract from strftime('%s', local_iso) to get the true epoch (SQLite assumes UTC)."""
    now = time.time()
    return int(round(now - dt.datetime.fromtimestamp(now).replace(tzinfo=dt.timezone.utc).timestamp())) * -1


def _chunks(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def as_list(v: Any) -> list:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return list(v.values())
    return [v]


def _bool(v: Any) -> int | None:
    """Lua boolean -> 0/1 (None stays None)."""
    if v is None:
        return None
    return 1 if v else 0


class Store:
    def __init__(self, db_path: Path):
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.con = sqlite3.connect(str(db_path))
        self.con.row_factory = sqlite3.Row
        self.con.executescript(SCHEMA_SQL.read_text(encoding="utf-8"))
        self._migrate()
        self._game_cache: dict[str, int] = {}
        self._last_slow_seq: dict[int, int] = {}
        self._schema: int | float | None = None  # mod export schema of the snapshot being ingested

    # columns added after the first release; CREATE TABLE IF NOT EXISTS does not add them to old DBs
    MIGRATIONS = (
        ("game", "lang", "TEXT"),
        ("snapshot", "accept_commands", "INTEGER"),
        ("snapshot", "cmd_ack", "TEXT"),
        ("vehicle", "icon_type", "TEXT"),
        ("vehicle", "model", "TEXT"),
        ("cargo_type", "key", "TEXT"),
        ("vehicle", "model_key", "TEXT"),
        ("vehicle", "parts", "TEXT"),
        ("line", "custom_filters", "INTEGER"),
        ("line", "reservation_priority", "REAL"),
        ("line_stop", "load_mode", "INTEGER"),
        ("company", "hq_x", "REAL"),
        ("company", "hq_y", "REAL"),
        ("company", "hq_id", "INTEGER"),
        ("line_stop", "min_wait", "REAL"),
        ("line_stop", "max_wait", "REAL"),
        ("line_stop", "max_add_wait", "REAL"),
        ("line_stop", "waypoints", "INTEGER"),
        ("line_stop", "force_unload", "INTEGER"),
        ("line_stop", "destroy_for_config_change", "INTEGER"),
        ("line_stop", "destroy_for_refresh", "INTEGER"),
        ("line_stop", "no_load", "TEXT"),
        ("line_stop", "max_load", "TEXT"),
        ("line_stop", "terminals", "TEXT"),
        ("line_stop", "alternatives", "TEXT"),
        ("snapshot", "camera", "TEXT"),
        ("vehicle_state", "cargo", "TEXT"),  # mod rev 8+: {"<cargo id>": count} of what is on board
        ("vehicle", "capacities", "TEXT"),   # mod rev 8+: {"<cargo id>": capacity} = what the vehicle can carry
        ("game", "label", "TEXT"),           # "<first town> · <year first seen>", to tell saves apart in the UI
        ("game", "last_game_day", "INTEGER"),  # year*10000+month*100+day of the last snapshot: detects a reload of an older save
        ("game", "reloads", "TEXT"),         # JSON [{at, from_day, to_day}]: each time the game date went backwards
    )

    # one-shot data fixes, tracked with PRAGMA user_version
    DATA_VERSION = 1

    def _migrate(self):
        for table, col, typ in self.MIGRATIONS:
            cols = {r["name"] for r in self.con.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                self.con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {typ}")
        v = self.con.execute("PRAGMA user_version").fetchone()[0]
        if v < 1:
            # mod schema 1 exported line capacities with cargo ids off by one (+1): the engine returns a
            # dense per-cargo array that Lua reads 1-based. Shift stored rows back and drop the phantom
            # "all zero" rows that the old mod exported for every cargo type.
            self.con.execute("DELETE FROM line_capacity WHERE IFNULL(used,0)=0 AND IFNULL(capacity,0)=0")
            self.con.execute("UPDATE line_capacity SET cargo_id = cargo_id - 1")
            self.con.execute("PRAGMA user_version = 1")
        self.con.commit()

    # ------------------------------------------------------------ game
    def game_id(self, snap: dict, now: str) -> int:
        player = snap.get("player")
        # a "game" = a player entity id; TF3 reuses small ids across saves, so also fold in the year of
        # the first snapshot seen in this process. Good enough to separate sessions in the dashboard.
        key = f"player:{player}"
        if key in self._game_cache:
            gid = self._game_cache[key]
            self.con.execute("UPDATE game SET last_seen=? WHERE game_id=?", (now, gid))
            return gid
        row = self.con.execute("SELECT game_id FROM game WHERE key=?", (key,)).fetchone()
        if row:
            gid = row["game_id"]
            self.con.execute("UPDATE game SET last_seen=? WHERE game_id=?", (now, gid))
        else:
            cur = self.con.execute(
                "INSERT INTO game(key, player_entity, first_seen, last_seen) VALUES (?,?,?,?)", (key, player, now, now)
            )
            gid = cur.lastrowid
        self._game_cache[key] = gid
        return gid

    def _track_game_day(self, gid: int, t: dict, now: str) -> None:
        """Remember the game date of the last snapshot. When it goes backwards by more than a day for the same
        save, the player reloaded an older savegame: log it in game.reloads (the history is kept, the dashboard
        shows a marker). The same key (player entity) is reused by the game for every load of that save."""
        y, m, d = t.get("year"), t.get("month"), t.get("day")
        if not all(isinstance(v, (int, float)) for v in (y, m, d)):
            return
        day = int(y) * 10000 + int(m) * 100 + int(d)
        row = self.con.execute("SELECT last_game_day, reloads FROM game WHERE game_id=?", (gid,)).fetchone()
        last = row["last_game_day"] if row else None
        if last is not None and day < last - 1:
            try:
                reloads = json.loads(row["reloads"]) if row["reloads"] else []
            except ValueError:
                reloads = []
            reloads.append({"at": now, "from_day": last, "to_day": day})
            reloads = reloads[-20:]
            self.con.execute("UPDATE game SET reloads=? WHERE game_id=?", (json.dumps(reloads), gid))
        if last != day:
            self.con.execute("UPDATE game SET last_game_day=? WHERE game_id=?", (day, gid))

    def _label_game(self, gid: int, towns: Any) -> None:
        """game.label = '<first town> · <first seen year>' once towns are known (slow section)."""
        if self.con.execute("SELECT label FROM game WHERE game_id=?", (gid,)).fetchone()["label"]:
            return
        names = [g(x, "name") for x in as_list(towns) if isinstance(g(x, "name"), str)]
        if not names:
            return
        row = self.con.execute("SELECT first_seen FROM game WHERE game_id=?", (gid,)).fetchone()
        self.con.execute("UPDATE game SET label=? WHERE game_id=?", (f"{sorted(names)[0]} · {row['first_seen'][:10]}", gid))

    # ------------------------------------------------------------ ingest
    def ingest_geo(self, snap: dict, geo: dict) -> bool:
        """Store the map geography written by the mod (rev 11, tf3dash_geo.lua) for the game `snap` belongs to.
        One row per game, replaced on every new file; skipped when geo_seq did not change. Returns True when stored."""
        gid = self.game_id(snap, iso())
        seq = geo.get("geo_seq")
        row = self.con.execute("SELECT geo_seq FROM geo WHERE game_id=?", (gid,)).fetchone()
        if row and row["geo_seq"] == seq and seq is not None:
            return False
        water = [as_list(w) for w in as_list(geo.get("water"))]
        edges = [as_list(e) for e in as_list(geo.get("edges"))]
        data = {"bounds": as_list(geo.get("bounds")) or None, "tiles": as_list(geo.get("tiles")) or None,
                "water_level": geo.get("water_level"), "water": water, "edges": edges, "geo_seq": seq}
        self.con.execute(
            "INSERT OR REPLACE INTO geo(game_id, geo_seq, received_at, edge_count, water_count, data) VALUES (?,?,?,?,?,?)",
            (gid, seq, iso(), len(edges), len(water), json.dumps(data, separators=(",", ":"))))
        self.con.commit()
        return True

    def ingest(self, snap: dict) -> int | None:
        now = iso()
        real_time = iso(snap.get("real_time")) if isinstance(snap.get("real_time"), (int, float)) else now
        gid = self.game_id(snap, now)
        self._schema = snap.get("schema") if isinstance(snap.get("schema"), (int, float)) else 1
        t = snap.get("time") or {}
        seq = snap.get("seq")
        # skip exact duplicates (file not rewritten since last read)
        dup = self.con.execute(
            "SELECT snapshot_id FROM snapshot WHERE game_id=? AND seq=? AND real_time=?", (gid, seq, real_time)
        ).fetchone()
        if dup:
            return None
        ack = snap.get("cmd_ack")
        cam = snap.get("camera")  # mod rev 7+: {x, y, dist, angle, pitch, follow?}; absent with rev 6
        cur = self.con.execute(
            """INSERT INTO snapshot(game_id, seq, slow_seq, real_time, received_at, game_time_ms, year, month, day,
               time_of_day_s, speed, millis_per_day, tick, update_count, n_errors, accept_commands, cmd_ack, camera)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (gid, seq, snap.get("slow_seq"), real_time, now, t.get("game_time_ms"), t.get("year"), t.get("month"),
             t.get("day"), t.get("time_of_day_sec"), t.get("speed"), t.get("millis_per_day"), t.get("tick"),
             t.get("update_count"), len(as_list(snap.get("errors"))),
             b(snap.get("accept_commands")) if snap.get("accept_commands") is not None else None,
             json.dumps(ack) if isinstance(ack, dict) else None,
             json.dumps(cam) if isinstance(cam, dict) else None),
        )
        sid = cur.lastrowid
        if isinstance(t.get("lang"), str) and t["lang"]:
            self.con.execute("UPDATE game SET lang=? WHERE game_id=? AND (lang IS NULL OR lang<>?)", (t["lang"], gid, t["lang"]))
        self._track_game_day(gid, t, now)
        for e in as_list(snap.get("errors")):
            self.con.execute("INSERT INTO snapshot_error(snapshot_id, section, error) VALUES (?,?,?)",
                             (sid, g(e, "section"), g(e, "error")))

        self._finance(sid, snap.get("finance"))
        self._alerts(sid, snap.get("alerts"))
        self._vehicles(sid, gid, now, snap.get("vehicles"))

        # slow sections: only store when freshly collected (slow_seq changed)
        slow_seq = snap.get("slow_seq")
        if slow_seq is not None and self._last_slow_seq.get(gid) != slow_seq:
            self._last_slow_seq[gid] = slow_seq
            self._cargo_types(gid, snap.get("cargo_types"))
            self._company(sid, snap.get("company"))
            self._lines(sid, gid, now, slow_seq, snap.get("lines"))
            self._stations(sid, gid, now, snap.get("stations"))
            self._towns(sid, gid, now, snap.get("towns"))
            self._label_game(gid, snap.get("towns"))
            self._industries(sid, gid, now, snap.get("industries"))
            self._depots(sid, gid, now, snap.get("depots"))
        self.con.commit()
        return sid

    # ------------------------------------------------------------ sections
    def _finance(self, sid: int, f: Any):
        if not isinstance(f, dict):
            return
        self.con.execute(
            "INSERT OR REPLACE INTO finance VALUES (?,?,?,?,?,?,?)",
            (sid, f.get("balance"), f.get("bank_balance"), f.get("loan"), f.get("earnings_year_to_date"),
             f.get("passengers_transported"), f.get("cargo_transported")),
        )

    def _company(self, sid: int, c: Any):
        if not isinstance(c, dict):
            return
        self.con.execute(
            """INSERT OR REPLACE INTO company (snapshot_id, total_score, rail_vehicles, trams, road_vehicles, aircrafts, ships,
                   track_length_m, track_electric_m, bridge_length_m, tunnel_length_m, road_length_m, supplied_towns,
                   connected_industries, number_of_lines, total_stations, rail_stations, tram_stations, road_stations,
                   aircraft_stations, ship_stations, top_speed, top_length, oldest_vehicle, total_assets, debt,
                   hq_x, hq_y, hq_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (sid, c.get("totalScore"), c.get("railVehicles"), c.get("trams"), c.get("roadVehicles"), c.get("aircrafts"),
             c.get("ships"), c.get("trackTotalLength"), c.get("trackElectricLength"), c.get("bridgeTotalLength"),
             c.get("tunnelTotalLength"), c.get("roadTotalLength"), c.get("suppliedTowns"), c.get("connectedIndustries"),
             c.get("numberOfLines"), c.get("totalStations"), c.get("railStations"), c.get("tramStations"),
             c.get("roadStations"), c.get("aircraftStations"), c.get("shipStations"), c.get("topSpeed"),
             c.get("topLength"), c.get("oldestTransportVehicle"), c.get("totalAssets"), c.get("debt"),
             c.get("headquarterX"), c.get("headquarterY"), c.get("headquarterId")),
        )

    def _cargo_types(self, gid: int, cts: Any):
        for ct in as_list(cts):
            if isinstance(ct, dict) and ct.get("id") is not None:
                # name = localized display name (follows the game language); key = language-neutral id
                # from the resource file ("grain"), used by the dashboard for icons. Older mods don't send key.
                self.con.execute("""INSERT INTO cargo_type(game_id, cargo_id, name, key) VALUES (?,?,?,?)
                                    ON CONFLICT(game_id, cargo_id) DO UPDATE SET name=excluded.name, key=COALESCE(excluded.key, cargo_type.key)""",
                                 (gid, ct["id"], ct.get("name"), ct.get("key")))

    def _alerts(self, sid: int, a: Any):
        if not isinstance(a, dict):
            return
        ins = "INSERT INTO alert(snapshot_id, kind, entity_id, related_id, type_code, stop_index, amount, x, y, z, detail) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
        for p in as_list(a.get("line_problems")):
            x, y, z = xyz(g(p, "pos"))
            self.con.execute(ins, (sid, "line_problem", g(p, "line"), None, g(p, "type"), None, None, x, y, z, None))
        for p in as_list(a.get("line_issues")):
            self.con.execute(ins, (sid, "line_issue", g(p, "line"), g(p, "cargo_type"), g(p, "type"), g(p, "stop"), None, None, None, None, None))
        for p in as_list(a.get("vehicle_problems")):
            for v in as_list(g(p, "vehicles")):
                self.con.execute(ins, (sid, "vehicle_problem", v, None, g(p, "type"), None, None, None, None, None, None))
        for p in as_list(a.get("blocked_trains")):
            self.con.execute(ins, (sid, "blocked_train", g(p, "train"), g(p, "blocked_by"), None, None, None, None, None, None, None))
        for v in as_list(a.get("no_path_vehicles")):
            self.con.execute(ins, (sid, "no_path_vehicle", v, None, None, None, None, None, None, None, None))
        for p in as_list(a.get("town_problems")):
            for tn in as_list(g(p, "towns")):
                self.con.execute(ins, (sid, "town_problem", tn, None, g(p, "type"), None, None, None, None, None, None))
        for p in as_list(a.get("closing_industries")):
            self.con.execute(ins, (sid, "closing_industry", g(p, "industry"), None, None, None, None, None, None, None,
                                   json.dumps({"name": g(p, "name")})))
        for p in as_list(a.get("thrown_away_cargo")):
            self.con.execute(ins, (sid, "thrown_away_cargo", g(p, "stock_list"), None, None, None, g(p, "amount"), None, None, None, None))

    def _vehicles(self, sid: int, gid: int, now: str, vs: Any):
        for v in as_list(vs):
            if not isinstance(v, dict) or v.get("id") is None:
                continue
            vid = v["id"]
            caps = v.get("capacities")
            self.con.execute(
                """INSERT INTO vehicle(game_id, vehicle_id, name, carrier, capacity, first_seen, last_seen, icon_type, model, model_key, parts, capacities)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(game_id, vehicle_id) DO UPDATE SET name=COALESCE(excluded.name, vehicle.name),
                   carrier=COALESCE(excluded.carrier, vehicle.carrier), capacity=COALESCE(excluded.capacity, vehicle.capacity),
                   last_seen=excluded.last_seen,
                   icon_type=COALESCE(excluded.icon_type, vehicle.icon_type), model=COALESCE(excluded.model, vehicle.model),
                   model_key=COALESCE(excluded.model_key, vehicle.model_key), parts=COALESCE(excluded.parts, vehicle.parts),
                   capacities=COALESCE(excluded.capacities, vehicle.capacities)""",
                (gid, vid, v.get("name"), clean_enum(v.get("carrier")), v.get("capacity"), now, now,
                 clean_enum(v.get("icon_type")), v.get("model"), v.get("model_key"), v.get("parts"),
                 json.dumps(caps, separators=(",", ":")) if isinstance(caps, dict) and caps else None),
            )
            x, y, z = xyz(v.get("pos"))
            cargo = v.get("cargo")
            self.con.execute(
                """INSERT OR REPLACE INTO vehicle_state(snapshot_id, vehicle_id, line_id, state, stop_index, x, y, z, speed_ms, load,
                   maintenance, running_cost, value, user_stopped, no_path, doors_open, depot_id, days_in_depot, days_at_terminal, closest_town, cargo)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (sid, vid, v.get("line"), clean_enum(v.get("state")), v.get("stop_index"), x, y, z, v.get("speed"), v.get("load"),
                 v.get("maintenance"), v.get("running_cost"), v.get("value"), b(v.get("user_stopped")), b(v.get("no_path")),
                 b(v.get("doors_open")), v.get("depot"), v.get("days_in_depot"), v.get("days_at_terminal"), v.get("closest_town"),
                 json.dumps(cargo, separators=(",", ":")) if isinstance(cargo, dict) and cargo else None),
            )

    def _lines(self, sid: int, gid: int, now: str, slow_seq: int, ls: Any):
        for l in as_list(ls):
            if not isinstance(l, dict) or l.get("id") is None:
                continue
            lid = l["id"]
            c = l.get("color") or {}
            self.con.execute(
                """INSERT INTO line(game_id, line_id, name, color_r, color_g, color_b, transport_modes, first_seen, last_seen)
                   VALUES (?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(game_id, line_id) DO UPDATE SET name=excluded.name, color_r=excluded.color_r, color_g=excluded.color_g,
                   color_b=excluded.color_b, transport_modes=excluded.transport_modes, last_seen=excluded.last_seen""",
                (gid, lid, l.get("name"), c.get("x"), c.get("y"), c.get("z"), json.dumps(as_list(l.get("transport_modes"))), now, now),
            )
            q = l.get("quality") or {}
            self.con.execute(
                "INSERT OR REPLACE INTO line_state VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (sid, lid, l.get("stops"), l.get("vehicles"), hz_to_headway(l.get("max_frequency")), l.get("throughput"), l.get("persons_on_line"),
                 q.get("pax_bad"), q.get("pax_total"), q.get("pax_avg"), q.get("cargo_bad"), q.get("cargo_total"), q.get("cargo_avg")),
            )
            # mod schema 1 exported these cargo ids off by one (see _migrate)
            shift = -1 if (self._schema or 1) < 2 else 0
            for cap in as_list(l.get("capacity")):
                if isinstance(cap, dict) and cap.get("cargo_type") is not None and (cap.get("capacity") or cap.get("used")):
                    self.con.execute("INSERT OR REPLACE INTO line_capacity VALUES (?,?,?,?,?)",
                                     (sid, lid, cap["cargo_type"] + shift, cap.get("used"), cap.get("capacity")))
            stops = as_list(l.get("stop_list"))
            if stops:
                self.con.execute("DELETE FROM line_stop WHERE game_id=? AND line_id=?", (gid, lid))
                for i, s in enumerate(stops, start=1):
                    no_load = as_list(g(s, "no_load")) if isinstance(s, dict) else []
                    max_load = as_list(g(s, "max_load")) if isinstance(s, dict) else []
                    terminals = [x for x in as_list(g(s, "terminals")) if isinstance(x, dict)] if isinstance(s, dict) else []
                    alternatives = [x for x in as_list(g(s, "alternatives")) if isinstance(x, dict)] if isinstance(s, dict) else []
                    self.con.execute(
                        """INSERT OR REPLACE INTO line_stop(game_id, line_id, stop_index, station_group, station, terminal, name, slow_seq,
                           load_mode, min_wait, max_wait, max_add_wait, waypoints, force_unload, destroy_for_config_change, destroy_for_refresh, no_load, max_load,
                           terminals, alternatives)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (gid, lid, i, g(s, "station_group"), g(s, "station"), g(s, "terminal"), g(s, "name"), slow_seq,
                         g(s, "load_mode"), g(s, "min_wait"), g(s, "max_wait"), g(s, "max_add_wait"), g(s, "waypoints"),
                         _bool(g(s, "force_unload")), _bool(g(s, "destroy_for_config_change")), _bool(g(s, "destroy_for_refresh")),
                         json.dumps([x for x in no_load if isinstance(x, (int, float))]) if no_load else None,
                         json.dumps([{"cargo_type": g(m, "cargo_type"), "max": g(m, "max")} for m in max_load if isinstance(m, dict)]) if max_load else None,
                         json.dumps(terminals) if terminals else None,
                         json.dumps([{"station": g(a, "station"), "terminal": g(a, "terminal")} for a in alternatives]) if alternatives is not None else None))
            if isinstance(l, dict) and (l.get("custom_filters") is not None or l.get("reservation_priority") is not None):
                self.con.execute("UPDATE line SET custom_filters=?, reservation_priority=? WHERE game_id=? AND line_id=?",
                                 (_bool(l.get("custom_filters")), l.get("reservation_priority"), gid, lid))

    def _stations(self, sid: int, gid: int, now: str, ss: Any):
        for s in as_list(ss):
            if not isinstance(s, dict) or s.get("id") is None:
                continue
            x, y, z = xyz(s.get("pos"))
            self.con.execute(
                """INSERT INTO station(game_id, station_id, name, town_id, station_group, is_cargo, construction, x, y, z, first_seen, last_seen)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(game_id, station_id) DO UPDATE SET name=excluded.name, town_id=excluded.town_id, station_group=excluded.station_group,
                   is_cargo=excluded.is_cargo, construction=excluded.construction, x=excluded.x, y=excluded.y, z=excluded.z, last_seen=excluded.last_seen""",
                (gid, s["id"], s.get("name"), s.get("town"), s.get("station_group"), b(s.get("cargo")), s.get("construction"), x, y, z, now, now),
            )
            self.con.execute("INSERT OR REPLACE INTO station_state VALUES (?,?,?,?,?,?,?)",
                             (sid, s["id"], s.get("used"), s.get("overflow"), s.get("pool_capacity"), s.get("terminal_capacity"), s.get("lines")))

    def _towns(self, sid: int, gid: int, now: str, ts: Any):
        def pair(p: Any) -> tuple[Any, Any]:
            return (g(p, "unhappy"), g(p, "total")) if isinstance(p, dict) else (None, None)

        for t in as_list(ts):
            if not isinstance(t, dict) or t.get("id") is None:
                continue
            tid = t["id"]
            x, y, z = xyz(t.get("pos"))
            self.con.execute(
                """INSERT INTO town(game_id, town_id, name, x, y, z, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(game_id, town_id) DO UPDATE SET name=excluded.name, x=excluded.x, y=excluded.y, z=excluded.z, last_seen=excluded.last_seen""",
                (gid, tid, t.get("name"), x, y, z, now, now),
            )
            usage = as_list(t.get("usage"))
            used = [g(u, "used") for u in usage] + [None] * 3
            h = t.get("happiness") or {}
            r = t.get("reach") or {}
            vals = [sid, tid, b(t.get("development_active")), t.get("cap_res"), t.get("cap_com"), t.get("cap_ind"),
                    used[0], used[1], used[2], t.get("stations"), t.get("buildings"), t.get("noise_db"), t.get("pollution_db"),
                    t.get("area_km2"), t.get("line_usage"), t.get("traffic_speed"), json.dumps(as_list(t.get("congestion_levels"))),
                    r.get("com_private"), r.get("com_public"), r.get("ind_private"), r.get("ind_public")]
            for k in ("inside", "at_building", "by_car", "walking", "to_resident", "to_non_resident", "from_resident", "from_non_resident"):
                vals.extend(pair(h.get(k)))
            self.con.execute("INSERT OR REPLACE INTO town_state VALUES (" + ",".join("?" * len(vals)) + ")", vals)
            for sc in as_list(t.get("stock")):
                if isinstance(sc, dict) and sc.get("cargo_type") is not None:
                    self.con.execute("INSERT OR REPLACE INTO town_cargo VALUES (?,?,?,?,?)",
                                     (sid, tid, sc["cargo_type"], sc.get("stock"), sc.get("capacity")))
            for sp in as_list(t.get("supply")):  # mod schema 3+
                if isinstance(sp, dict) and sp.get("cargo_type") is not None:
                    self.con.execute("INSERT OR REPLACE INTO town_supply VALUES (?,?,?,?,?,?,?)",
                                     (sid, tid, sp.get("land_use") or 0, sp["cargo_type"], sp.get("v1"), sp.get("v2"), sp.get("v3")))
            for tl in as_list(t.get("top_lines")):
                if isinstance(tl, dict) and tl.get("line") is not None:
                    ru, rt = pair(tl.get("resident"))
                    nu, nt = pair(tl.get("non_resident"))
                    self.con.execute("INSERT OR REPLACE INTO town_top_line VALUES (?,?,?,?,?,?,?)", (sid, tid, tl["line"], ru, rt, nu, nt))

    def _industries(self, sid: int, gid: int, now: str, inds: Any):
        for i in as_list(inds):
            if not isinstance(i, dict) or i.get("id") is None:
                continue
            iid = i["id"]
            x, y, z = xyz(i.get("pos"))
            self.con.execute(
                """INSERT INTO industry(game_id, industry_id, name, construction, stock_list, max_level, x, y, z, first_seen, last_seen)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(game_id, industry_id) DO UPDATE SET name=excluded.name, construction=excluded.construction,
                   stock_list=excluded.stock_list, max_level=excluded.max_level, x=excluded.x, y=excluded.y, z=excluded.z, last_seen=excluded.last_seen""",
                (gid, iid, i.get("name"), i.get("construction"), i.get("stock_list"), i.get("max_level"), x, y, z, now, now),
            )
            self.con.execute(
                "INSERT OR REPLACE INTO industry_state VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (sid, iid, i.get("level"), i.get("upgrade_progress"), i.get("closure_time"), b(i.get("manual")), b(i.get("producing")),
                 b(i.get("boost_rule")), b(i.get("boost_persons")), i.get("production_rating"), i.get("thrown_away")),
            )
            for c in as_list(i.get("inputs")):
                if isinstance(c, dict) and c.get("cargo_type") is not None:
                    self.con.execute("INSERT OR REPLACE INTO industry_cargo VALUES (?,?,?,?,?,?,?,?,?,?)",
                                     (sid, iid, c["cargo_type"], "in", None, None, None, c.get("consumed_year"), c.get("max_consumption_year"), c.get("delivered_year")))
            for c in as_list(i.get("outputs")):
                if isinstance(c, dict) and c.get("cargo_type") is not None:
                    self.con.execute("INSERT OR REPLACE INTO industry_cargo VALUES (?,?,?,?,?,?,?,?,?,?)",
                                     (sid, iid, c["cargo_type"], "out", c.get("produced_year"), c.get("max_production_year"), c.get("shipped_year"), None, None, None))

    def _depots(self, sid: int, gid: int, now: str, ds: Any):
        for d in as_list(ds):
            if not isinstance(d, dict) or d.get("id") is None:
                continue
            self.con.execute(
                """INSERT INTO depot(game_id, depot_id, name, carrier, first_seen, last_seen) VALUES (?,?,?,?,?,?)
                   ON CONFLICT(game_id, depot_id) DO UPDATE SET name=excluded.name, carrier=excluded.carrier, last_seen=excluded.last_seen""",
                (gid, d["id"], d.get("name"), clean_enum(d.get("carrier")), now, now),
            )
            self.con.execute("INSERT OR REPLACE INTO depot_state VALUES (?,?,?,?,?,?,?)",
                             (sid, d["id"], d.get("vehicles"), d.get("incoming"), d.get("maintenance_pool"), d.get("pool_max"), d.get("pool_avg")))

    # ------------------------------------------------------------ retention / aggregation
    # detail (one row per snapshot) is kept for `detail_hours`; everything older is rolled up into the
    # agg_*_min tables (one row per real-time minute) and deleted. Slow sections (lines, towns, stations,
    # industries, depots: one row per ~30 s) are small and simply purged after `slow_days`.
    def rollup(self, detail_hours: float = 2.0, slow_days: float = 14.0, say=None) -> dict:
        c = self.con
        stats = {"agg_minutes": 0, "deleted_snapshots": 0, "purged_slow": 0}
        now = time.time()
        for row in c.execute("SELECT game_id FROM game").fetchall():
            gid = row["game_id"]
            # 1) aggregate all closed minutes not yet aggregated (regardless of retention: cheap and keeps
            #    the aggregate series continuous so the UI can read detail + agg without a gap)
            meta = c.execute("SELECT agg_until FROM agg_meta WHERE game_id=?", (gid,)).fetchone()
            agg_until = meta["agg_until"] if meta else 0
            last_closed = int(now // 60) * 60 - 60  # the current minute is still open
            if agg_until == 0:
                first = c.execute("SELECT MIN(real_time) t FROM snapshot WHERE game_id=?", (gid,)).fetchone()["t"]
                if first is None:
                    continue
                agg_until = int(_epoch(first) // 60) * 60 - 60
            if last_closed > agg_until:
                lo, hi = agg_until + 60, last_closed + 60  # buckets in [lo, hi)
                stats["agg_minutes"] += self._aggregate_range(gid, lo, hi)
                c.execute("INSERT INTO agg_meta(game_id, agg_until) VALUES (?,?) ON CONFLICT(game_id) DO UPDATE SET agg_until=excluded.agg_until", (gid, last_closed))
            # 2) delete detail snapshots older than detail_hours (CASCADE removes vehicle_state, finance, alert...)
            #    only if their minute has been aggregated. Slow-section rows ride on snapshots too, so keep the
            #    snapshot row itself when it carries slow data younger than slow_days: we delete only the heavy
            #    children instead.
            cutoff = iso(now - detail_hours * 3600)
            cutoff_min = int((now - detail_hours * 3600) // 60) * 60
            if cutoff_min - 60 <= last_closed:
                old = [r["snapshot_id"] for r in c.execute(
                    "SELECT snapshot_id FROM snapshot WHERE game_id=? AND real_time < ? AND snapshot_id NOT IN (SELECT snapshot_id FROM line_state)",
                    (gid, cutoff)).fetchall()]
                if old:
                    for chunk in _chunks(old, 500):
                        marks = ",".join("?" * len(chunk))
                        c.execute(f"DELETE FROM snapshot WHERE snapshot_id IN ({marks})", chunk)
                    stats["deleted_snapshots"] += len(old)
                # snapshots that carry slow sections: drop their heavy fast children, keep the row
                c.execute("""DELETE FROM vehicle_state WHERE snapshot_id IN
                             (SELECT snapshot_id FROM snapshot WHERE game_id=? AND real_time < ?)""", (gid, cutoff))
                c.execute("""DELETE FROM alert WHERE snapshot_id IN
                             (SELECT snapshot_id FROM snapshot WHERE game_id=? AND real_time < ?)""", (gid, cutoff))
            # 3) purge slow sections older than slow_days entirely
            slow_cut = iso(now - slow_days * 86400)
            cur = c.execute("DELETE FROM snapshot WHERE game_id=? AND real_time < ?", (gid, slow_cut))
            stats["purged_slow"] += cur.rowcount or 0
        c.commit()
        if (stats["deleted_snapshots"] or stats["purged_slow"]) and say:
            say(f"rollup: +{stats['agg_minutes']} min aggregated, {stats['deleted_snapshots']} detail snapshots folded, {stats['purged_slow']} old slow snapshots purged")
        return stats

    def _aggregate_range(self, gid: int, lo: int, hi: int) -> int:
        """Build agg rows for buckets in [lo, hi) from detail rows. Returns number of fleet buckets written."""
        c = self.con
        # SQLite has no epoch column: compute it from the ISO real_time (local time, as written by iso())
        # strftime('%s') treats the string as UTC, so correct with the local offset at that instant.
        off = _local_offset()
        bucket = f"(CAST(strftime('%s', s.real_time) AS INTEGER) - {off}) / 60 * 60"
        where = f"s.game_id=? AND {bucket} >= ? AND {bucket} < ?"
        c.execute(f"""
            INSERT OR REPLACE INTO agg_fleet_min(game_id, bucket, n, game_time_ms, year, month, day, vehicles, en_route, at_terminal, in_depot, to_depot,
                                                 load, capacity, avg_speed, maint, stuck)
            SELECT ?, b, COUNT(*), MAX(game_time_ms), MAX(year), MAX(month), MAX(day), AVG(vehicles), AVG(en_route), AVG(at_terminal), AVG(in_depot), AVG(to_depot),
                   AVG(load), AVG(capacity), AVG(avg_speed), AVG(maint), AVG(stuck)
            FROM (
              SELECT {bucket} b, s.game_time_ms, s.year, s.month, s.day, COUNT(*) vehicles,
                     SUM(vs.state='EN_ROUTE') en_route, SUM(vs.state='AT_TERMINAL') at_terminal, SUM(vs.state='IN_DEPOT') in_depot, SUM(vs.state='GOING_TO_DEPOT') to_depot,
                     SUM(vs.load) load, SUM(v.capacity) capacity, AVG(CASE WHEN vs.state='EN_ROUTE' THEN vs.speed_ms END) avg_speed, AVG(vs.maintenance) maint,
                     SUM(CASE WHEN vs.state='EN_ROUTE' AND vs.speed_ms < 0.5 THEN 1 ELSE 0 END) stuck
              FROM snapshot s JOIN vehicle_state vs USING(snapshot_id) JOIN vehicle v ON v.game_id=s.game_id AND v.vehicle_id=vs.vehicle_id
              WHERE {where} GROUP BY s.snapshot_id)
            GROUP BY b""", (gid, gid, lo, hi))
        n = c.execute("SELECT changes()").fetchone()[0]
        c.execute(f"""
            INSERT OR REPLACE INTO agg_vehicle_min(game_id, vehicle_id, bucket, n, year, month, day, state, speed_ms, load, maintenance, x, y, line_id, stop_index)
            SELECT s.game_id, vs.vehicle_id, {bucket} b, COUNT(*), MAX(s.year), MAX(s.month), MAX(s.day),
                   (SELECT state FROM vehicle_state q JOIN snapshot sq USING(snapshot_id) WHERE q.vehicle_id=vs.vehicle_id AND sq.game_id=s.game_id
                      AND (CAST(strftime('%s', sq.real_time) AS INTEGER) - {off}) / 60 * 60 = {bucket} GROUP BY state ORDER BY COUNT(*) DESC LIMIT 1),
                   AVG(vs.speed_ms), AVG(vs.load), AVG(vs.maintenance), AVG(vs.x), AVG(vs.y), MAX(vs.line_id), MAX(vs.stop_index)
            FROM snapshot s JOIN vehicle_state vs USING(snapshot_id)
            WHERE {where} GROUP BY vs.vehicle_id, b""", (gid, lo, hi))
        c.execute(f"""
            INSERT OR REPLACE INTO agg_finance_min(game_id, bucket, n, game_time_ms, year, month, day, balance, loan, earnings_ytd, passengers_transported, cargo_transported)
            SELECT s.game_id, {bucket} b, COUNT(*), MAX(s.game_time_ms), MAX(s.year), MAX(s.month), MAX(s.day),
                   AVG(f.balance), AVG(f.loan), AVG(f.earnings_ytd), MAX(f.passengers_transported), MAX(f.cargo_transported)
            FROM snapshot s JOIN finance f USING(snapshot_id)
            WHERE {where} GROUP BY b""", (gid, lo, hi))
        return n

    # ------------------------------------------------------------ status
    def games(self) -> list[sqlite3.Row]:
        return self.con.execute("""SELECT g.game_id, g.key, g.first_seen, g.last_seen, g.lang,
                                          (SELECT COUNT(*) FROM snapshot s WHERE s.game_id=g.game_id) snapshots,
                                          (SELECT COUNT(*) FROM line l WHERE l.game_id=g.game_id) lines,
                                          (SELECT COUNT(*) FROM vehicle v WHERE v.game_id=g.game_id) vehicles,
                                          (SELECT name FROM town t WHERE t.game_id=g.game_id ORDER BY town_id LIMIT 1) a_town
                                   FROM game g ORDER BY g.game_id""").fetchall()

    def forget_game(self, gid: int) -> dict:
        """Delete everything recorded for one game (another save). snapshot children cascade; the
        per-game catalogue tables are deleted explicitly."""
        c = self.con
        stats = {}
        stats["snapshots"] = c.execute("DELETE FROM snapshot WHERE game_id=?", (gid,)).rowcount
        for tbl in ("line_stop", "line", "vehicle", "station", "town", "industry", "depot", "cargo_type",
                    "agg_fleet_min", "agg_vehicle_min", "agg_finance_min", "agg_meta"):
            stats[tbl] = c.execute(f"DELETE FROM {tbl} WHERE game_id=?", (gid,)).rowcount
        stats["game"] = c.execute("DELETE FROM game WHERE game_id=?", (gid,)).rowcount
        c.commit()
        c.execute("VACUUM")
        self._game_cache = {k: v for k, v in self._game_cache.items() if v != gid}
        return stats

    def status(self) -> str:
        c = self.con
        out = []
        n = c.execute("SELECT COUNT(*) FROM snapshot").fetchone()[0]
        out.append(f"snapshots: {n}")
        for row in c.execute("SELECT game_id, key, first_seen, last_seen FROM game"):
            out.append(f"game {row['game_id']} ({row['key']}): {row['first_seen']} -> {row['last_seen']}")
        last = c.execute("SELECT * FROM v_latest_snapshot").fetchone()
        if last:
            f = c.execute("SELECT * FROM finance WHERE snapshot_id=?", (last["snapshot_id"],)).fetchone()
            out.append(f"latest: seq {last['seq']} at {last['real_time']} game {last['year']}-{last['month']}-{last['day']} speed {last['speed']} errors {last['n_errors']}")
            if f:
                out.append(f"  balance {f['balance']} loan {f['loan']} earnings_ytd {f['earnings_ytd']} pax {f['passengers_transported']} cargo {f['cargo_transported']}")
            for tbl in ("vehicle_state", "line_state", "station_state", "town_state", "industry_state", "depot_state", "alert"):
                k = c.execute(f"SELECT COUNT(*) FROM {tbl} WHERE snapshot_id=?", (last["snapshot_id"],)).fetchone()[0]
                out.append(f"  {tbl}: {k}")
        for tbl in ("vehicle_state", "agg_fleet_min", "agg_vehicle_min", "agg_finance_min"):
            out.append(f"rows {tbl}: {c.execute(f'SELECT COUNT(*) FROM {tbl}').fetchone()[0]}")
            for row in c.execute("SELECT section, error FROM snapshot_error WHERE snapshot_id=?", (last["snapshot_id"],)):
                out.append(f"  ERROR {row['section']}: {row['error']}")
        size = c.execute("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()").fetchone()[0]
        out.append(f"db size: {size / 1024 / 1024:.1f} MB")
        return "\n".join(out)


def read_live(path: Path, retries: int = 5, delay: float = 0.2) -> dict | None:
    """Read and parse the live file, tolerating a partially written file."""
    for _ in range(retries):
        try:
            data = luatable.load(str(path))
            if isinstance(data, dict) and "seq" in data:
                return data
        except (luatable.LuaParseError, OSError, ValueError):
            pass
        time.sleep(delay)
    return None


# Mod schema 4 (rev 6+): live.lua only holds the fast part (time, finance, alerts, moving vehicle fields). The slow
# sections are in slow_<section>.lua next to it, each tagged with the slow_seq of the cycle it belongs to. The mod
# writes them one per frame and only then lets live.lua point at the new slow_seq, so when live.lua says slow_seq N
# every slow_*.lua is either already N or about to be re-read. SlowFiles re-reads a file when its mtime changes and
# assembles a schema-3-shaped snapshot (everything in one dict) so that Store.ingest did not have to change.
SLOW_SECTIONS = ("company", "cargo_types", "lines", "stations", "towns", "industries", "depots", "vehicles")
# static vehicle fields moved to slow_vehicles.lua in schema 4
VEHICLE_STATIC = ("name", "carrier", "capacity", "icon_type", "model", "model_key", "parts", "running_cost", "value")


class SlowFiles:
    def __init__(self, live: Path):
        self.dir = live.parent
        self.prefix = tf3paths.prefix_for(self.dir)  # tf3dash_ (rev 9+, towns_industries) or none (legacy folder)
        self.mtime: dict[str, float] = {}
        # section -> {slow_seq: items}; the two most recent cycles are kept because the mod may already be
        # writing cycle N+1 while live.lua still refers to N
        self.data: dict[str, dict[Any, Any]] = {}

    def refresh(self) -> None:
        for name in SLOW_SECTIONS:
            p = self.dir / f"{self.prefix}slow_{name}.lua"
            try:
                m = os.path.getmtime(p)
            except OSError:
                continue
            if m == self.mtime.get(name):
                continue
            for _ in range(3):
                try:
                    d = luatable.load(str(p))
                    if isinstance(d, dict) and "slow_seq" in d:
                        # keep the two most recently *read* cycles (dict order = insertion order); not the two
                        # highest: slow_seq restarts at 1 when a save is (re)loaded
                        versions = self.data.setdefault(name, {})
                        versions.pop(d["slow_seq"], None)
                        versions[d["slow_seq"]] = d.get("items")
                        while len(versions) > 2:
                            del versions[next(iter(versions))]
                        self.mtime[name] = m
                        break
                except (luatable.LuaParseError, OSError, ValueError):
                    pass
                time.sleep(0.1)

    def complete_for(self, slow_seq: Any) -> bool:
        return all(slow_seq in self.data.get(n, {}) for n in SLOW_SECTIONS)

    def geo(self) -> dict | None:
        """tf3dash_geo.lua (mod rev 11): the map's bounds, water and network. Returns the parsed table when the
        file changed since the last call, else None. Big (hundreds of KB) and rare, so read only on mtime change."""
        p = self.dir / f"{self.prefix}geo.lua"
        try:
            m = os.path.getmtime(p)
        except OSError:
            return None
        if m == self.mtime.get("geo"):
            return None
        for _ in range(3):
            try:
                d = luatable.load(str(p))
                if isinstance(d, dict) and "edges" in d:
                    self.mtime["geo"] = m
                    return d
            except (luatable.LuaParseError, OSError, ValueError):
                pass
            time.sleep(0.1)
        return None

    def merge(self, snap: dict) -> dict:
        """Return a schema-3-shaped snapshot: slow sections inlined, vehicle static fields merged back."""
        ss = snap.get("slow_seq")
        out = dict(snap)
        errors = list(as_list(snap.get("errors")))
        errors.extend(as_list(snap.get("slow_errors")))
        out["errors"] = errors
        for name in SLOW_SECTIONS:
            if name == "vehicles":
                continue
            out[name] = self.data.get(name, {}).get(ss)
        static = {g(v, "id"): v for v in as_list(self.data.get("vehicles", {}).get(ss)) if isinstance(v, dict)}
        merged = []
        for v in as_list(snap.get("vehicles")):
            if not isinstance(v, dict):
                continue
            s = static.get(v.get("id"))
            if s:
                v = dict(v)
                for k in VEHICLE_STATIC:
                    if k in s and k not in v:
                        v[k] = s[k]
            merged.append(v)
        out["vehicles"] = merged
        return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--live", type=Path, default=None, help="path to the live file written by the mod (tf3dash_live.lua) (default: auto-detect Steam userdata / config.json)")
    ap.add_argument("--db", type=Path, default=None, help="SQLite database path (default: db/tf3_dashboard.db)")
    ap.add_argument("--once", action="store_true", help="import once and exit")
    ap.add_argument("--status", action="store_true", help="print database summary and exit")
    ap.add_argument("--poll", type=float, default=0.5, help="seconds between file checks")
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--detail-hours", type=float, default=2.0, help="keep per-snapshot detail (vehicles, alerts, finance) for this many hours; older data is rolled up per minute (0 = never)")
    ap.add_argument("--slow-days", type=float, default=14.0, help="purge lines/towns/stations/industries history older than this many days")
    ap.add_argument("--rollup", action="store_true", help="run the retention roll-up once and exit")
    ap.add_argument("--list-games", action="store_true", help="list the saves (games) recorded in the database and exit")
    ap.add_argument("--forget-game", type=int, metavar="GAME_ID", help="delete everything recorded for this game id (another save) and exit")
    args = ap.parse_args(argv)
    args.db = tf3paths.db_path(args.db)
    args.db.parent.mkdir(parents=True, exist_ok=True)
    # auto mode (no --live, no config.json/env): the collector may switch to another export folder later
    args.live_auto = args.live is None and not tf3paths.load_config().get("export_dir") and not os.environ.get("TF3_EXPORT_DIR")
    args.live = tf3paths.live_path(args.live)

    # a restore requested from the dashboard (db/restore_pending.db staged by server.py): swap it in before opening
    tf3paths.apply_pending_restore(args.db)

    store = Store(args.db)
    if args.status:
        print(store.status())
        return 0
    if args.rollup:
        st = store.rollup(args.detail_hours or 1e9, args.slow_days, say=print)
        print(st); print(store.status())
        return 0
    if args.list_games:
        for r in store.games():
            print(f"game {r['game_id']}: {r['key']}  {r['first_seen']} -> {r['last_seen']}  lang={r['lang']}  "
                  f"snapshots={r['snapshots']} lines={r['lines']} vehicles={r['vehicles']}  e.g. town: {r['a_town']}")
        return 0
    if args.forget_game is not None:
        st = store.forget_game(args.forget_game)
        print(f"game {args.forget_game} forgotten: {st}")
        return 0

    def say(msg: str, level: str = "info"):
        if not args.quiet:
            console.say(msg, level)

    if not args.quiet:
        console.banner(f"TF3 Dashboard collector {VERSION}", f"database: {args.db}")
    for w in tf3paths.sync_warning(args.db):
        say(w, "warn")
    # the game does not always create the export folder itself (saveUserdata then fails with "directory not
    # available"): make sure it exists wherever the game may write
    for d in tf3paths.ensure_export_dir(args.live.parent if args.live else None):
        say(f"created {d} for the game to write into", "ok")
    if args.live is None:
        say(tf3paths.not_found_hint(), "error")
        if args.once:
            return 1
        say("waiting for the game to create it...", "wait")
    else:
        dg = tf3paths.diag(args.live.parent)
        say(f"watching: {args.live}  ({dg['store'] or 'configured'} userdata folder)", "ok")
        if not dg["live_exists"]:
            say(f"{args.live.name} is not there yet: start the game and enable 'Second Screen Dashboard' in the Mods menu of your "
                "savegame (subscribing in the Mod Hub is not enough), the file appears a few seconds after the map is loaded",
                "wait")
    last_log_sig = None

    def report_game_log():
        # what the game itself says (crash_dump/stdout.txt): its userdata folder, whether the mod ran, write errors.
        # Printed once per log change, only while nothing is coming in
        nonlocal last_log_sig
        info = tf3paths.game_log(args.live.parent if args.live else None)
        sig = (info["log"], int(info["log_mtime"])) if info else None
        if sig == last_log_sig:
            return
        last_log_sig = sig
        for level, line in tf3paths.game_log_lines(info, args.live.parent if args.live else None):
            say(line, level)

    report_game_log()
    last_mtime = -1.0
    imported = 0
    next_rollup = 0.0
    next_detect = 0.0
    next_wait_msg = time.time() + 30
    slow_files: SlowFiles | None = None
    warned_incomplete = False
    # console compaction: the first few snapshots in full, then one summary line per minute; anything unusual
    # (error, new game, import resuming after a gap) is shown in full at once
    FULL_LINES = 5
    minute: dict = {"n": 0, "since": time.time(), "last": None}
    last_import_at = 0.0
    last_game_key = None

    def flush_minute():
        if minute["n"] and minute["last"]:
            say(f"{minute['n']} snapshots in the last minute, last: {minute['last']}", "ok")
        minute["n"], minute["since"] = 0, time.time()

    try:
        while True:
            if args.live is None or (last_mtime < 0 and not args.live.exists()):
                # nothing yet: re-run detection every few seconds (first start, other Steam account, game not launched)
                if time.time() >= next_detect:
                    next_detect = time.time() + 5
                    for d in tf3paths.ensure_export_dir():  # the game may have been started meanwhile
                        say(f"created {d} for the game to write into", "ok")
                    found = tf3paths.live_path()
                    if found is not None and found.exists() and found != args.live:
                        args.live = found
                        say(f"watching: {args.live}", "ok")
                if time.time() >= next_wait_msg:
                    next_wait_msg = time.time() + 30
                    if args.live is None:
                        say("still no Transport Fever 3 userdata folder found (is the game installed on this PC?)", "wait")
                    else:
                        say(f"still waiting for {args.live} (mod enabled in the savegame? map loaded?)", "wait")
                    report_game_log()
                if args.live is None:
                    if args.once:
                        return 1
                    time.sleep(args.poll)
                    continue
            if args.detail_hours > 0 and time.time() >= next_rollup:
                try:
                    store.rollup(args.detail_hours, args.slow_days, say=say)
                except sqlite3.Error as e:
                    say(f"rollup failed: {e}", "error")
                next_rollup = time.time() + 60
            if minute["n"] and time.time() - minute["since"] >= 60:
                flush_minute()
            try:
                mtime = os.path.getmtime(args.live)
            except OSError:
                mtime = -1.0
            # The export may move: mod rev 9 writes to towns_industries/tf3dash_live.lua while rev 8 wrote to
            # dashboard_export/live.lua (game build 40420 closed that folder). When the watched file has been silent
            # for a while and another candidate is fresher, follow it (no explicit --live / config given).
            if args.live_auto and mtime > 0 and time.time() - mtime > 20 and time.time() >= next_detect:
                next_detect = time.time() + 10
                found = tf3paths.live_path()
                if found is not None and found != args.live:
                    try:
                        if os.path.getmtime(found) > mtime:
                            args.live, last_mtime, slow_files = found, -1.0, None
                            flush_minute()
                            say(f"the mod now writes to {found}: following it", "ok")
                            continue
                    except OSError:
                        pass
            if mtime != last_mtime and mtime > 0:
                last_mtime = mtime
                snap = read_live(args.live)
                if snap is None:
                    say(f"could not parse {args.live.name} (will retry)", "error")
                else:
                    schema = snap.get("schema") or 1
                    if schema >= 4:
                        # mod rev 6+: slow sections in slow_*.lua; wait until the set matching live.lua is complete
                        if slow_files is None:
                            slow_files = SlowFiles(args.live)
                        slow_files.refresh()
                        if not slow_files.complete_for(snap.get("slow_seq")):
                            if not warned_incomplete or time.time() >= warned_incomplete:
                                have = {n: sorted(v) for n, v in slow_files.data.items()}
                                say(f"waiting for the mod's {slow_files.prefix}slow_*.lua files to reach slow_seq {snap.get('slow_seq')} "
                                    f"(normal for a few seconds after loading a save); have: {have}", "wait")
                                warned_incomplete = time.time() + 30
                            # re-check the live file on the next loop even if its mtime did not change
                            last_mtime = -1.0
                            time.sleep(args.poll)
                            continue
                        warned_incomplete = False
                        snap = slow_files.merge(snap)
                    try:
                        sid = store.ingest(snap)
                    except Exception as e:  # noqa: BLE001 - one bad snapshot must not kill the collector
                        import traceback
                        store.con.rollback()
                        tb = traceback.format_exc()
                        flush_minute()
                        say(f"ingest failed (seq={snap.get('seq')}): {e!r} -- see {ERROR_LOG}", "error")
                        with open(ERROR_LOG, "a", encoding="utf-8") as fh:
                            fh.write(f"\n===== {iso()} seq={snap.get('seq')} slow_seq={snap.get('slow_seq')}\n{tb}")
                        sid = None
                    if sid is not None and slow_files is not None:
                        # map geography (mod rev 11): one file, re-read only when the mod rewrote it
                        try:
                            geo = slow_files.geo()
                            if geo is not None and store.ingest_geo(snap, geo):
                                say(f"map geography: {len(as_list(geo.get('edges')))} network edges, "
                                    f"{len(as_list(geo.get('water')))} water contours", "ok")
                        except Exception as e:  # noqa: BLE001
                            store.con.rollback()
                            say(f"geo ingest failed: {e!r}", "error")
                    if sid is not None:
                        imported += 1
                        t = snap.get("time") or {}
                        f = snap.get("finance") or {}
                        n_err = len(as_list(snap.get("errors")))
                        desc = (f"seq={snap.get('seq')} {t.get('year')}-{t.get('month'):0>2}-{t.get('day'):0>2} "
                                f"speed={t.get('speed')} balance={f.get('balance')} vehicles={len(as_list(snap.get('vehicles')))}"
                                + (f" errors={n_err}" if n_err else ""))
                        now = time.time()
                        game_key = snap.get("player")  # same key Store.game_id() uses to tell saves apart
                        resumed = now - last_import_at > 120 and last_import_at > 0
                        # a live.lua left over from a previous session is imported too (it is data); say so, else
                        # the player believes the game is exporting right now
                        written = snap.get("real_time")
                        stale_min = int((now - written) // 60) if isinstance(written, (int, float)) and now - written > 120 else 0
                        if imported <= FULL_LINES or resumed or n_err or stale_min or (game_key and game_key != last_game_key):
                            flush_minute()
                            if resumed:
                                say(f"export resumed after {int((now - last_import_at) // 60)} min", "ok")
                            say(f"snapshot #{sid} {desc}", "ok" if not (n_err or stale_min) else "warn")
                            if stale_min:
                                say(f"this export was written by the game {stale_min} min ago (left over from an earlier session); "
                                    f"nothing new until the game runs with the mod enabled", "wait")
                            if imported == FULL_LINES:
                                say("from now on: one summary line per minute (errors are always shown)", "info")
                        else:
                            minute["n"] += 1
                            minute["last"] = desc
                        last_import_at = now
                        last_game_key = game_key or last_game_key
            if args.once:
                if mtime <= 0:
                    say(f"{args.live.name} not found", "error")
                    return 1
                break
            time.sleep(args.poll)
    except KeyboardInterrupt:
        pass
    flush_minute()
    say(f"done, {imported} snapshot(s) imported", "info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
