"""Generates a realistic-looking sequence of snapshots (same shape as the mod output) and feeds them
to the collector Store, to exercise the dashboard without the game. Writes test/fake.db."""
from __future__ import annotations

import math
import random
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "collector"))
from collector import Store  # noqa: E402

random.seed(7)
DB = HERE / "fake.db"
if DB.exists():
    DB.unlink()
store = Store(DB)

CARGO = [(0, "PASSENGERS"), (1, "LOGS"), (2, "PLANKS"), (3, "COAL"), (4, "IRON_ORE"), (5, "STEEL"), (6, "GOODS"), (7, "FOOD"), (8, "GRAIN"), (9, "OIL"), (10, "FUEL")]
TOWNS = [(100, "Nyon", 2000, 3500), (101, "Gland", 5200, 4100), (102, "Rolle", 8400, 3900), (103, "Morges", 12100, 4800), (104, "Lausanne", 16000, 6200), (105, "Aubonne", 7900, 7300), (106, "Coppet", -1500, 2200)]
INDS = [(200, "Scierie du Jura", "sawmill", 4000, 9000, [1], [2]), (201, "Forêt de Bière", "forest", 2500, 10500, [], [1]), (202, "Mine de charbon", "coal_mine", 14000, 10000, [], [3]),
        (203, "Aciérie de Vallorbe", "steel_mill", 10000, 11000, [3, 4], [5]), (204, "Mine de fer", "iron_ore_mine", 18000, 9000, [], [4]), (205, "Usine de biens", "goods_factory", 13000, 7500, [2, 5], [6]),
        (206, "Ferme de la Côte", "farm", 6000, 1200, [], [8]), (207, "Minoterie", "food_processing", 9500, 1500, [8], [7])]
STATIONS = [(300, "Nyon gare", 100, False, 2100, 3400), (301, "Gland gare", 101, False, 5250, 4000), (302, "Rolle gare", 102, False, 8450, 3800), (303, "Morges gare", 103, False, 12150, 4700),
            (304, "Lausanne CFF", 104, False, 16100, 6100), (305, "Scierie quai", 100, True, 4100, 8900), (306, "Forêt chargement", 101, True, 2600, 10400), (307, "Aciérie quai", 103, True, 10100, 10900),
            (308, "Usine biens quai", 103, True, 13100, 7400), (309, "Morges port cargo", 103, True, 12300, 4300), (310, "Aubonne arrêt", 105, False, 7950, 7250), (311, "Coppet gare", 106, False, -1450, 2150)]
LINES = [(400, "IR Léman", (0.85, 0.2, 0.2), [300, 301, 302, 303, 304], 0, "RAIL", 6), (401, "RE Coppet–Nyon", (0.2, 0.5, 0.9), [311, 300], 0, "RAIL", 2),
         (402, "Bois → Scierie", (0.5, 0.35, 0.1), [306, 305], 1, "ROAD", 5), (403, "Planches → Usine", (0.9, 0.7, 0.2), [305, 308], 2, "RAIL", 3),
         (404, "Charbon/fer → Aciérie", (0.3, 0.3, 0.3), [307], 3, "RAIL", 4), (405, "Biens → Morges", (0.2, 0.7, 0.4), [308, 309], 6, "ROAD", 6),
         (406, "Bus Aubonne–Rolle", (0.6, 0.3, 0.8), [310, 302], 0, "ROAD", 3)]
DEPOTS = [(500, "Dépôt rail Nyon", "RAIL"), (501, "Dépôt routier Gland", "ROAD")]

VEHICLES = []
vid = 600
for lid, name, _, stops, cargo, carrier, n in LINES:
    for k in range(n):
        icon = ("TrainElectric" if lid in (401, 403) else "TrainSteam") if carrier == "RAIL" else ("Bus" if cargo == 0 else "Truck")
        model = {"TrainElectric": "Re 4/4 I", "TrainSteam": "C 5/6 Elefant", "Bus": "Saurer 3CT1D", "Truck": "Saurer C-Typ"}[icon]
        # language-neutral model keys + consist (as exported by the mod) so the real game icons show up
        parts = {"TrainElectric": ["train/re_44i", "waggon/ew_ii", "waggon/ew_ii", "-waggon/ew_ii"],
                 "TrainSteam": ["train/c6_8", "waggon/bulk_1_1794", "waggon/bulk_1_1794", "waggon/bulk_1_1794", "waggon/bulk_1_1794"],
                 "Bus": ["bus/saurer_tuescher"], "Truck": ["truck/saurer_c_typ_box"]}[icon]
        VEHICLES.append({"id": vid, "name": f"{name} #{k + 1}", "carrier": carrier, "line": lid, "cargo": cargo, "capacity": 120 if carrier == "RAIL" else 30, "age": random.random(), "icon_type": icon, "model": model,
                         "model_key": parts[0].lstrip("-"), "parts": ",".join(parts)})
        vid += 1


def fake_terminals(station_group: int, cargo: int, carrier: str) -> list:
    """Terminals like the game's panel: cargo stations get 4 cargo terminals (goods-specialised, 2 universal, liquid),
    passenger stations 3 platforms; station 300 also has a bus stop (incompatible for trains)."""
    out = []
    if station_group in (305, 306, 307, 308, 309):
        specs = [("GOODS", "Goods", (0.25, 0.45, 0.85), 2.0), ("UNIVERSAL", None, None, None), ("UNIVERSAL", None, None, None), ("LIQUID", "Liquid", (0.9, 0.9, 0.9), 0.25)]
        for i, (cls, name, color, mod) in enumerate(specs):
            rec = {"n": i + 1, "station": 0, "terminal": i, "pax": False, "cargo": True, "class": cls, "length": 240, "compatible": True}
            if name:
                rec["class_name"] = name; rec["class_color"] = {"x": color[0], "y": color[1], "z": color[2]}
            if cargo == 6 and mod:  # goods line: +100 % on the goods terminal, -75 % on the liquid one
                rec["speed_mod"] = mod
            if i == 3:
                rec["overlength"] = True
            out.append(rec)
    else:
        for i in range(3):
            out.append({"n": i + 1, "station": 0, "terminal": i, "pax": True, "cargo": False, "class": "PASSENGERS", "length": 160 if i < 2 else 320, "compatible": True, "overlength": i < 2 and carrier == "RAIL"})
        if station_group == 300:
            out.append({"n": 4, "station": 1, "terminal": 0, "pax": True, "cargo": False, "class": "PASSENGERS", "length": 0, "compatible": carrier != "RAIL"})
    return out
N = 1500             # snapshots: ~3 h of real time at 7 s, so the roll-up produces per-minute aggregates for the oldest hour
REAL_STEP = 7.0      # seconds of real time between snapshots
STEP_MS = 7 * 86400 * 1000 // 7   # 1 game day per snapshot
start_year = 1905
real0 = time.time() - N * REAL_STEP

balance = 2_500_000.0
loan = 1_000_000
pax_total, cargo_total = 0, 0
seq = 0
for k in range(N):
    seq += 1
    game_ms = k * STEP_MS
    day_of_year = k % 365
    year = start_year + k // 365
    month = 1 + (day_of_year * 12) // 365
    day = 1 + day_of_year - ((month - 1) * 365) // 12
    growth = 1 + k / 400
    income = 9000 * growth + random.gauss(0, 2500) - 5500
    if k > 0 and k % 30 == 0:
        income -= 150_000  # purchase
    balance += income
    if day_of_year == 0 and k > 0:
        earnings_ytd = income
    earnings_ytd = (balance - 2_500_000) * (day_of_year + 1) / 365 if year == start_year else income * (day_of_year + 1)
    pax_total += int(80 * growth + random.randint(0, 20))
    cargo_total += int(40 * growth + random.randint(0, 10))
    speed = 0 if k in (40, 41, 42) else random.choice([1, 1, 1, 2, 4])

    vehicles = []
    for v in VEHICLES:
        line = next(l for l in LINES if l[0] == v["line"])
        stops = [s for s in STATIONS if s[0] in line[3]]
        t = (k / 20 + v["id"] * 0.37) % 1
        i0 = int(t * len(stops)) % len(stops)
        i1 = (i0 + 1) % len(stops)
        f = (t * len(stops)) % 1
        x = stops[i0][4] + (stops[i1][4] - stops[i0][4]) * f + random.gauss(0, 30)
        y = stops[i0][5] + (stops[i1][5] - stops[i0][5]) * f + random.gauss(0, 30)
        broken = (v["id"] == 612 and 90 <= k <= 130)
        state = "IN_DEPOT" if (v["id"] % 17 == 0 and k % 50 < 8) else "AT_TERMINAL" if f < 0.12 else "EN_ROUTE"
        maint = max(0.05, 1 - ((k / N) * 0.9 + v["age"] * 0.5) % 1)
        vehicles.append({"id": v["id"], "name": v["name"], "carrier": v["carrier"], "icon_type": v["icon_type"], "model": v["model"], "model_key": v["model_key"], "parts": v["parts"], "state": state, "line": v["line"], "stop_index": i0,
                         "pos": {"x": x, "y": y, "z": 400}, "speed": 0 if state != "EN_ROUTE" else (33 if v["carrier"] == "RAIL" else 14) * random.uniform(0.5, 1),
                         "load": int(v["capacity"] * random.uniform(0.2, 1.0)), "capacity": v["capacity"], "maintenance": maint,
                         "running_cost": 48000 if v["carrier"] == "RAIL" else 12000, "value": int((180000 if v["carrier"] == "RAIL" else 40000) * (0.4 + 0.6 * maint)),
                         "user_stopped": (v["id"] == 620 and k > 100), "no_path": broken, "depot": 500 if state == "IN_DEPOT" else None,
                         "days_in_depot": 3 if state == "IN_DEPOT" else 0, "days_at_terminal": 0, "doors_open": state == "AT_TERMINAL", "closest_town": 100 + (v["id"] % 7)})

    alerts = {"line_problems": [], "blocked_trains": [], "no_path_vehicles": [vv["id"] for vv in vehicles if vv["no_path"]],
              "vehicle_problems": [{"vehicles": [vv["id"] for vv in vehicles if vv["no_path"]], "type": 3}] if any(vv["no_path"] for vv in vehicles) else [],
              "town_problems": [], "closing_industries": [], "thrown_away_cargo": [], "line_issues": []}
    if 90 <= k <= 130:
        alerts["line_problems"].append({"line": 404, "type": 3, "pos": {"x": 10100, "y": 10900, "z": 400}})
    if k > 140:
        alerts["closing_industries"].append({"industry": 206, "name": "Ferme de la Côte"})
        alerts["line_issues"].append({"line": 406, "type": 3, "stop": 1, "cargo_type": 0})
    if k % 25 == 0:
        alerts["thrown_away_cargo"].append({"stock_list": 2051, "amount": random.randint(5, 40)})

    snap = {"schema": 2, "mod": "tf3_dashboard_export", "seq": seq, "slow_seq": seq - (seq % 6), "real_time": int(real0 + k * REAL_STEP), "player": 42, "errors": [],
            "time": {"game_time_ms": game_ms, "year": year, "month": month, "day": day, "speed": speed, "millis_per_day": 2000, "tick": k * 100, "update_count": k * 90, "time_of_day_sec": (k * 3600) % 86400, "lang": "fr"},
            "accept_commands": True, "cmd_ack": {"id": 1, "cmd": "ping", "ok": True, "real_time": int(real0 + k * REAL_STEP)} if k == N - 1 else None,
            # mod rev 7: where the player looks (drifts slowly across the map)
            "camera": {"x": 10000 + 1500 * math.sin(k / 40), "y": 10500 + 1200 * math.cos(k / 55), "dist": 400 + 200 * math.sin(k / 20), "angle": (k / 80) % 6.28, "pitch": -0.9},
            "finance": {"balance": int(balance), "loan": loan, "earnings_year_to_date": int(earnings_ytd), "passengers_transported": pax_total, "cargo_transported": cargo_total, "bank_balance": int(balance)},
            "alerts": alerts, "vehicles": vehicles}
    if k == 0 or seq % 6 == 0:
        nveh = len(VEHICLES)
        snap["company"] = {"headquarterId": 9000, "headquarterX": 5300, "headquarterY": 3900, "totalScore": int(1000 + k * 12), "railVehicles": sum(1 for v in VEHICLES if v["carrier"] == "RAIL"), "trams": 0, "roadVehicles": sum(1 for v in VEHICLES if v["carrier"] == "ROAD"), "aircrafts": 0, "ships": 0,
                           "trackTotalLength": 42000 + k * 30, "trackElectricLength": 18000 + k * 20, "bridgeTotalLength": 1200, "tunnelTotalLength": 600, "roadTotalLength": 15000, "suppliedTowns": 6, "connectedIndustries": 6,
                           "numberOfLines": len(LINES), "totalStations": len(STATIONS), "railStations": 9, "tramStations": 0, "roadStations": 3, "aircraftStations": 0, "shipStations": 0, "topSpeed": 33.3, "topLength": 180,
                           "oldestTransportVehicle": 1900, "balance": int(balance), "totalAssets": int(balance + nveh * 150000), "debt": loan}
        snap["cargo_types"] = [{"id": i, "name": n} for i, n in CARGO]
        snap["lines"] = []
        for lid, name, col, stops, cargo, carrier, n in LINES:
            lv = [vv for vv in vehicles if vv["line"] == lid]
            bad_rate = 0.08 + (0.5 if (lid == 404 and 90 <= k <= 130) else 0) + 0.15 * math.sin(k / 30 + lid)
            tot = 40 * len(lv)
            snap["lines"].append({"id": lid, "name": name, "stops": len(stops), "vehicles": len(lv), "color": {"x": col[0], "y": col[1], "z": col[2]},
                                  "max_frequency": 600 / max(1, len(lv)), "throughput": 200 * len(lv), "persons_on_line": sum(vv["load"] for vv in lv) if cargo == 0 else 0,
                                  "quality": {"pax_bad": int(tot * max(0, bad_rate)) if cargo == 0 else 0, "pax_total": tot if cargo == 0 else 0, "pax_avg": 0.8, "cargo_bad": int(tot * max(0, bad_rate)) if cargo else 0, "cargo_total": tot if cargo else 0, "cargo_avg": 0.7},
                                  "capacity": [{"cargo_type": cargo, "cargo": CARGO[cargo][1], "used": sum(vv["load"] for vv in lv), "capacity": sum(vv["capacity"] for vv in lv)}] + ([{"cargo_type": 4, "cargo": "IRON_ORE", "used": 90, "capacity": 240}] if lid == 404 else []),
                                  "stop_list": [{"station_group": s, "station": 0, "terminal": 0, "name": next(x[1] for x in STATIONS if x[0] == s), "load_mode": (1 if (k == 0 and cargo) else 0), "min_wait": 0, "max_wait": -1, "max_add_wait": (60 if cargo == 0 else 0), "waypoints": k, "force_unload": False, "destroy_for_config_change": False, "destroy_for_refresh": False, "no_load": ([cargo] if (k == len(stops) - 1 and cargo) else []), "max_load": [], "terminals": fake_terminals(s, cargo, carrier), "alternatives": ([{"station": 0, "terminal": 1}, {"station": 0, "terminal": 2}] if s in (308, 309, 300) else []), "waiting": ([{"cargo_type": cargo, "total": 12 + 7 * k, "bad": (3 if k == 0 else 0)}] if k < len(stops) - 1 else [])} for k, s in enumerate(stops)], "custom_filters": bool(cargo), "transport_modes": [7, 8] if carrier == "RAIL" else [3, 4]})
        snap["stations"] = [{"id": sid, "name": nm, "town": tw, "cargo": cg, "used": int(random.uniform(5, 160) * growth), "overflow": random.choice([0, 0, 0, 12]), "pool_capacity": 200, "terminal_capacity": 160,
                             "station_group": sid, "lines": sum(1 for l in LINES if sid in l[3]), "pos": {"x": x, "y": y, "z": 400}, "construction": "station/rail/era_a/passenger.con"} for sid, nm, tw, cg, x, y in STATIONS]
        snap["towns"] = []
        for tid, nm, x, y in TOWNS:
            base = 300 + (tid - 100) * 180
            cap = int(base * (1 + k / 300))
            unhappy = int(60 * (0.1 + 0.2 * abs(math.sin(k / 40 + tid))))
            snap["towns"].append({"id": tid, "name": nm, "development_active": tid != 106, "cap_res": cap, "cap_com": cap // 2, "cap_ind": cap // 3,
                                  "usage": [{"used": int(cap * 0.9), "capacity": cap}, {"used": int(cap * 0.4), "capacity": cap // 2}, {"used": int(cap * 0.3), "capacity": cap // 3}],
                                  "happiness": {"inside": {"unhappy": unhappy, "total": 300}, "at_building": {"unhappy": 2, "total": 100}, "by_car": {"unhappy": 10, "total": 80}, "walking": {"unhappy": 1, "total": 50},
                                                "to_resident": {"unhappy": unhappy // 2, "total": 120}, "to_non_resident": {"unhappy": 3, "total": 40}, "from_resident": {"unhappy": unhappy // 3, "total": 110}, "from_non_resident": {"unhappy": 2, "total": 30}},
                                  "noise_db": 45 + (tid - 100) * 2, "pollution_db": 30 + (tid - 100), "area_km2": 1.2 + (tid - 100) * 0.4,
                                  "reach": {"com_private": 3, "com_public": 2, "ind_private": 2, "ind_public": 1}, "line_usage": 0.25 + 0.3 * (k / N) * (1 if tid < 105 else 0.3),
                                  "traffic_speed": 12 - (k / N) * 4, "congestion_levels": [40, 20, 8, 2], "stock": [{"cargo_type": 6, "cargo": "GOODS", "stock": int(30 * (k / N)), "capacity": 60}, {"cargo_type": 7, "cargo": "FOOD", "stock": 5, "capacity": 40}],
                                  "supply": [{"land_use": 0, "cargo_type": 6, "v1": int(120 * (k / N)), "v2": 300, "v3": 2}, {"land_use": 0, "cargo_type": 7, "v1": 15, "v2": 200, "v3": 1},
                                             {"land_use": 1, "cargo_type": 6, "v1": int(70 * (k / N)), "v2": 180, "v3": 1}, {"land_use": 2, "cargo_type": 6, "v1": int(50 * (k / N)), "v2": 120, "v3": 1}],
                                  "top_lines": [{"line": 400, "resident": {"unhappy": unhappy // 2, "total": 90}, "non_resident": {"unhappy": 1, "total": 20}}],
                                  "pos": {"x": x, "y": y, "z": 400}, "stations": 2, "buildings": cap // 6})
        snap["industries"] = []
        for iid, nm, con, x, y, ins, outs in INDS:
            served = iid not in (204, 206)
            prod = int(200 * growth * (1 if served else 0.3))
            snap["industries"].append({"id": iid, "name": nm, "level": 1 + k // 90, "max_level": 4, "closure_time": 999 if (iid == 206 and k > 140) else 0, "upgrade_progress": (k % 90) / 90, "manual": False,
                                       "stock_list": iid * 10 + 1, "pos": {"x": x, "y": y, "z": 400}, "construction": f"industry/{con}.con", "production_rating": 0.9 if served else 0.2,
                                       "producing": served or k % 7 == 0, "boost_rule": iid == 203, "boost_persons": False, "thrown_away": 0 if served else 30,
                                       "inputs": [{"cargo_type": c, "cargo": CARGO[c][1], "consumed_year": prod, "max_consumption_year": 400, "delivered_year": prod + 5} for c in ins],
                                       "outputs": [{"cargo_type": c, "cargo": CARGO[c][1], "produced_year": prod, "max_production_year": 400, "shipped_year": prod if served else 0} for c in outs]})
        snap["depots"] = [{"id": did, "name": nm, "carrier": car, "vehicles": sum(1 for vv in vehicles if vv["state"] == "IN_DEPOT" and vv["carrier"] == car), "incoming": 0, "maintenance_pool": 12, "pool_max": 9, "pool_avg": 6.5} for did, nm, car in DEPOTS]
    store.ingest(snap)

# retention: fold everything older than 2 h into per-minute aggregates (like the live collector does)
print(store.rollup(detail_hours=2.0, slow_days=14, say=print))
print(store.status())
print("db:", DB)
