"""Supply chains: which lines carry what between which industries, whether they have enough vehicles, and what
goes wrong along the way. Pure functions over the rows the server already reads (lines, stations, industries), plus
the saved chains (a small JSON file next to the database: the server opens the database read-only).

Model:
- a node is an industry ("i:<id>") or a warehouse ("w:<id>") in the cargo catchment of a station (mod schema 6+);
- a leg is one cargo carried by one line from a source node at one stop to the nodes that take it at the other stops.
  A stop is a source of cargo c when an industry around it produces c (or a warehouse around it holds c), the stop is
  allowed to load c (no_load) and the line has capacity for c. Sinks consume c (industry input) or accept it
  (warehouse). A warehouse the line unloads c into is not also a source of c for the same line;
- the flow of a leg is what its source produces (industry) or ships (warehouse) per year, split evenly between the
  enabled legs leaving that source with that cargo (all lines, not only the chain); "moved" is the same share of what
  the source actually ships per year. Both come from the game's own per-year figures, so moved < flow means the
  lines do not pick up everything that is produced. The game's line capacity (used / capacity) is only used as a
  load factor: its time unit is not documented, so it is never compared with the per-year flows;
- a chain is a named set of lines (and of legs switched off because the line does not really carry them).
"""
from __future__ import annotations

import datetime
import json
import threading
from pathlib import Path
from typing import Any

PAX = 0  # cargo id of passengers

# alert thresholds
LOAD_HIGH = 0.90       # line load factor above which it is a bottleneck
LOAD_LOW = 0.20        # line load factor below which it has too many vehicles (with 2 vehicles or more)
LATE_SHARE = 0.30      # share of late cargo above which the line is a bottleneck
LATE_MIN = 5           # ... counted only from this many cargo items on the line
PROD_LOW = 0.50        # industry producing below this share of its maximum
INPUT_LOW = 0.70       # input consumed below this share of the maximum consumption
SHIPPED_LOW = 0.80     # line moves less than this share of what its sources produce = short of vehicles
LIMIT_MARGIN = 0.95    # input below this share of the maximum = the input limits the industry


def _f(v: Any) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _json(v: Any, default: Any) -> Any:
    if isinstance(v, (list, dict)):
        return v
    try:
        return json.loads(v) if v else default
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------- storage (saved chains)
class ChainStore:
    """Saved chains per game in a JSON file: {"games": {"<game_id>": [{id, name, lines, disabled, created}]}}."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def _load(self) -> dict:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.path)

    def list(self, gid: int) -> list[dict]:
        with self.lock:
            return list(self._load().get("games", {}).get(str(gid), []))

    def save(self, gid: int, name: str, lines: list, disabled: list, chain_id: int | None = None) -> dict:
        name = str(name or "").strip()[:80]
        if not name:
            raise ValueError("name required")
        lines = [int(x) for x in lines]
        if not lines:
            raise ValueError("a chain needs at least one line")
        disabled = [str(x) for x in disabled or []]
        with self.lock:
            data = self._load()
            chains = data.setdefault("games", {}).setdefault(str(gid), [])
            now = datetime.datetime.now().isoformat(timespec="seconds")
            target = next((c for c in chains if c.get("id") == chain_id), None) if chain_id is not None else None
            if target is None:
                # saving under an existing name replaces that chain, like the game's own "save as"
                target = next((c for c in chains if c.get("name") == name), None)
            if target is None:
                target = {"id": max([c.get("id", 0) for c in chains] + [0]) + 1, "created": now}
                chains.append(target)
            target.update({"name": name, "lines": lines, "disabled": disabled, "updated": now})
            self._save(data)
            return dict(target)

    def delete(self, gid: int, chain_id: int) -> bool:
        with self.lock:
            data = self._load()
            chains = data.get("games", {}).get(str(gid), [])
            keep = [c for c in chains if c.get("id") != chain_id]
            if len(keep) == len(chains):
                return False
            data["games"][str(gid)] = keep
            self._save(data)
            return True


# ---------------------------------------------------------------- network (nodes and legs of every line)
class Network:
    def __init__(self, lines: list[dict], stations: list[dict], industries: list[dict], cargo_types: list[dict]):
        self.lines = {l["line_id"]: l for l in lines}
        self.cargo = {c["cargo_id"]: c for c in cargo_types}
        self.nodes: dict[str, dict] = {}
        for i in industries:
            outs, ins = {}, {}
            for c in i.get("cargo") or []:
                if c.get("direction") == "out":
                    outs[c["cargo_id"]] = {"rate": _f(c.get("produced_year")), "max": _f(c.get("max_prod_year")), "moved": _f(c.get("shipped_year"))}
                elif c.get("direction") == "in":
                    ins[c["cargo_id"]] = {"rate": _f(c.get("consumed_year")), "max": _f(c.get("max_cons_year")), "moved": _f(c.get("delivered_year"))}
            self.nodes[f"i:{i['industry_id']}"] = {
                "key": f"i:{i['industry_id']}", "kind": "industry", "id": i["industry_id"], "name": i.get("name"),
                "outputs": outs, "inputs": ins, "producing": i.get("producing"), "closure_time": i.get("closure_time"),
                "thrown_away": i.get("thrown_away"), "production_rating": i.get("production_rating"),
                "boost": bool(i.get("boost_rule") or i.get("boost_persons")), "x": i.get("x"), "y": i.get("y"),
            }
        # stations: catchment nodes; warehouses are only known through the station that has them
        self.station_nodes: dict[int, list[str]] = {}
        self.group_stations: dict[int, list[int]] = {}
        self.has_catchment = False
        for s in stations:
            sid = s["station_id"]
            if s.get("station_group") is not None:
                self.group_stations.setdefault(s["station_group"], []).append(sid)
            catch = _json(s.get("catchment"), None)
            if catch is None:
                continue
            self.has_catchment = True
            keys = []
            for e in catch:
                if not isinstance(e, dict) or e.get("id") is None:
                    continue
                if e.get("kind") == "industry":
                    k = f"i:{e['id']}"
                    if k in self.nodes:
                        keys.append(k)
                elif e.get("kind") == "warehouse":
                    k = f"w:{e['id']}"
                    if k not in self.nodes:
                        cargo = {}
                        for x in e.get("cargo") or []:
                            if isinstance(x, dict) and x.get("cargo_type") is not None:
                                cargo[x["cargo_type"]] = {"rate": _f(x.get("shipped_year")), "max": 0.0, "moved": _f(x.get("shipped_year"))}
                        self.nodes[k] = {"key": k, "kind": "warehouse", "id": e["id"], "name": None, "station_name": s.get("name"),
                                         "outputs": cargo, "inputs": {c: dict(v) for c, v in cargo.items()}, "x": s.get("x"), "y": s.get("y")}
                    keys.append(k)
            self.station_nodes[sid] = keys
        self.legs: list[dict] = []
        self.legs_by_line: dict[int, list[dict]] = {}
        for l in lines:
            ll = self._line_legs(l)
            self.legs.extend(ll)
            self.legs_by_line[l["line_id"]] = ll

    def stop_nodes(self, stop: dict) -> list[str]:
        se = stop.get("station_entity")
        if se is not None and se in self.station_nodes:
            return self.station_nodes[se]
        # older data (no station_entity): every station of the stop's group
        out: list[str] = []
        for sid in self.group_stations.get(stop.get("station_group"), []):
            for k in self.station_nodes.get(sid, []):
                if k not in out:
                    out.append(k)
        return out

    @staticmethod
    def line_cargos(l: dict) -> set:
        return {c["cargo_id"] for c in l.get("capacities") or [] if c.get("cargo_id") not in (None, PAX) and _f(c.get("capacity")) > 0}

    def _line_legs(self, l: dict) -> list[dict]:
        stops = l.get("stop_list") or []
        if len(stops) < 2:
            return []
        per_stop = [self.stop_nodes(s) for s in stops]
        cargos = self.line_cargos(l)
        # (stop index, warehouse, cargo) the line unloads into: not a source of that cargo for this line
        unloads: set = set()
        for i, nodes in enumerate(per_stop):
            for k in nodes:
                n = self.nodes[k]
                if n["kind"] != "industry":
                    continue
                for c in n["outputs"]:
                    for j, others in enumerate(per_stop):
                        if j != i:
                            for k2 in others:
                                if self.nodes[k2]["kind"] == "warehouse" and c in self.nodes[k2]["inputs"]:
                                    unloads.add((j, k2, c))
        legs, seen = [], set()
        for i, nodes in enumerate(per_stop):
            no_load = set(_json(stops[i].get("no_load"), []) or [])
            for k in nodes:
                src = self.nodes[k]
                for c in src["outputs"]:
                    if cargos and c not in cargos or c in no_load or (k, c) in seen or (i, k, c) in unloads:
                        continue
                    if src["kind"] == "warehouse" and not cargos:
                        continue  # a line without vehicles yet: do not list everything its warehouses hold
                    sinks, sink_stop = [], None
                    for j, others in enumerate(per_stop):
                        if j == i:
                            continue
                        for k2 in others:
                            if k2 != k and k2 not in sinks and c in self.nodes[k2]["inputs"]:
                                sinks.append(k2)
                                sink_stop = j if sink_stop is None else sink_stop
                    if src["kind"] == "warehouse" and not sinks:
                        continue  # a warehouse feeding nothing on this line is not a leg
                    seen.add((k, c))
                    legs.append({"key": f"{l['line_id']}:{k}:{c}", "line_id": l["line_id"], "cargo_id": c, "source": k, "sinks": sinks,
                                 "src_stop": i + 1, "sink_stop": (sink_stop if sink_stop is not None else (i + 1) % len(stops)) + 1})
        return legs

    # lines connected to the given ones through shared industries / warehouses, upstream and downstream
    def connected(self, seed: list[int]) -> list[int]:
        node_lines: dict[str, set] = {}
        for leg in self.legs:
            for k in [leg["source"]] + leg["sinks"]:
                node_lines.setdefault(k, set()).add(leg["line_id"])
        out, todo, done_nodes = [x for x in seed if x in self.lines], list(seed), set()
        while todo:
            lid = todo.pop()
            for leg in self.legs_by_line.get(lid, []):
                for k in [leg["source"]] + leg["sinks"]:
                    if k in done_nodes:
                        continue
                    done_nodes.add(k)
                    for other in sorted(node_lines.get(k, ())):
                        if other not in out:
                            out.append(other)
                            todo.append(other)
        return out

    # ------------------------------------------------------------ view of a set of lines
    def view(self, line_ids: list[int], disabled: list[str] | None = None) -> dict:
        disabled_set = set(disabled or [])
        # flow split: enabled legs leaving the same source with the same cargo, over every line
        per_source: dict[tuple, int] = {}
        for leg in self.legs:
            if leg["key"] not in disabled_set:
                per_source[(leg["source"], leg["cargo_id"])] = per_source.get((leg["source"], leg["cargo_id"]), 0) + 1
        lines_out, used_nodes = [], []
        totals = {"lines": 0, "cargo_year": 0.0, "short": 0, "covered": 0}
        for lid in line_ids:
            l = self.lines.get(lid)
            if not l:
                continue
            legs = []
            need: dict[int, float] = {}
            moved: dict[int, float] = {}
            for leg in self.legs_by_line.get(lid, []):
                src = self.nodes[leg["source"]]
                on = leg["key"] not in disabled_set
                share = max(1, per_source.get((leg["source"], leg["cargo_id"]), 1))
                out = src["outputs"].get(leg["cargo_id"], {})
                supply = out.get("rate", 0.0) / share if on else 0.0
                shipped = out.get("moved", 0.0) / share if on else 0.0
                if on:
                    need[leg["cargo_id"]] = need.get(leg["cargo_id"], 0.0) + supply
                    moved[leg["cargo_id"]] = moved.get(leg["cargo_id"], 0.0) + shipped
                    for k in [leg["source"]] + leg["sinks"]:
                        if k not in used_nodes:
                            used_nodes.append(k)
                legs.append({**leg, "enabled": on, "flow": round(supply, 1), "moved": round(shipped, 1), "cargo": self._cargo(leg["cargo_id"]),
                             "source_name": self._node_label(src), "sink_names": [self._node_label(self.nodes[k]) for k in leg["sinks"]]})
            caps = []
            for c in l.get("capacities") or []:
                if c.get("cargo_id") == PAX:
                    continue
                caps.append({"cargo_id": c["cargo_id"], "cargo": c.get("cargo"), "cargo_key": c.get("cargo_key"),
                             "used": _f(c.get("used")), "capacity": _f(c.get("capacity")),
                             "need": round(need.get(c["cargo_id"], 0.0), 1), "moved": round(moved.get(c["cargo_id"], 0.0), 1)})
            for cid, n in need.items():  # cargo the chain needs carried but the line has no capacity for
                if not any(x["cargo_id"] == cid for x in caps):
                    caps.append({"cargo_id": cid, **self._cargo(cid), "used": 0.0, "capacity": 0.0, "need": round(n, 1), "moved": round(moved.get(cid, 0.0), 1)})
            total_need = sum(need.values())
            total_moved = sum(moved.values())
            load = max([x["used"] / x["capacity"] for x in caps if x["capacity"] > 0] or [0.0])
            vehicles = l.get("vehicles") or 0
            if not vehicles:
                status = "none"
            elif total_need <= 0:
                status = "unknown"
            elif total_moved < total_need * SHIPPED_LOW or load >= LOAD_HIGH:
                status = "short"
            else:
                status = "ok"
            totals["lines"] += 1
            totals["cargo_year"] += total_need
            totals["short"] += status in ("short", "none") and total_need > 0
            totals["covered"] += status == "ok"
            stops = []
            for idx, s in enumerate(l.get("stop_list") or [], start=1):
                loads = sorted({x["cargo_id"] for x in legs if x["enabled"] and x["src_stop"] == idx})
                unloads = sorted({x["cargo_id"] for x in legs if x["enabled"] and x["sink_stop"] == idx})
                stops.append({"stop_index": idx, "name": s.get("name"), "loads": [self._cargo(c) for c in loads],
                              "unloads": [self._cargo(c) for c in unloads],
                              "nodes": [self._node_label(self.nodes[k]) for k in self.stop_nodes(s)]})
            lines_out.append({"line_id": lid, "name": l.get("name"), "color_r": l.get("color_r"), "color_g": l.get("color_g"), "color_b": l.get("color_b"),
                              "vehicles": vehicles, "cargo_bad": l.get("cargo_bad"), "cargo_total": l.get("cargo_total"),
                              "status": status, "need": round(total_need, 1), "moved": round(total_moved, 1), "load": round(load, 3),
                              "capacities": caps, "legs": legs, "stops": stops})
        nodes_out = [self._node_view(self.nodes[k]) for k in used_nodes]
        totals["cargo_year"] = round(totals["cargo_year"])
        return {"lines": lines_out, "nodes": nodes_out, "totals": totals, "has_catchment": self.has_catchment}

    def _cargo(self, cid: int) -> dict:
        c = self.cargo.get(cid) or {}
        return {"cargo_id": cid, "cargo": c.get("name"), "cargo_key": c.get("key")}

    @staticmethod
    def _node_label(n: dict) -> dict:
        return {"key": n["key"], "kind": n["kind"], "id": n["id"], "name": n.get("name"), "station_name": n.get("station_name")}

    def _node_view(self, n: dict) -> dict:
        out = {**self._node_label(n), "x": n.get("x"), "y": n.get("y")}
        if n["kind"] == "warehouse":
            out["cargo"] = [{**self._cargo(c), "shipped": round(v["rate"], 1)} for c, v in n["outputs"].items() if v["rate"] > 0]
            return out
        ins = [{**self._cargo(c), "rate": round(v["rate"], 1), "max": round(v["max"], 1), "moved": round(v["moved"], 1)} for c, v in n["inputs"].items()]
        outs = [{**self._cargo(c), "rate": round(v["rate"], 1), "max": round(v["max"], 1), "moved": round(v["moved"], 1)} for c, v in n["outputs"].items()]
        util = max([o["rate"] / o["max"] for o in outs if o["max"] > 0] or [0.0])
        limited = None
        ratios = [(i["rate"] / i["max"], i) for i in ins if i["max"] > 0]
        if ratios:
            r, worst = min(ratios, key=lambda x: x[0])
            if r < LIMIT_MARGIN:
                limited = {k: worst[k] for k in ("cargo_id", "cargo", "cargo_key")}
        out.update({"inputs": ins, "outputs": outs, "utilization": round(util, 3), "limited_by": limited,
                    "producing": n.get("producing"), "closure_time": n.get("closure_time"), "thrown_away": n.get("thrown_away"),
                    "boost": n.get("boost")})
        return out


# ---------------------------------------------------------------- alerts
def alerts(view: dict) -> list[dict]:
    """Chain alerts in the shape of the game alerts (kind, entity_id, entity_name, type_code, related_id, amount)."""
    out: list[dict] = []

    def add(kind: str, ent: dict, code: int, amount: float | None = None, cargo: dict | None = None):
        out.append({"kind": kind, "entity_id": ent["id"], "entity_name": ent.get("name") or "", "type_code": code,
                    "amount": None if amount is None else int(round(amount)),
                    "related_id": cargo.get("cargo_id") if cargo else None, "cargo": cargo.get("cargo") if cargo else None,
                    "x": ent.get("x"), "y": ent.get("y")})

    for l in view["lines"]:
        ent = {"id": l["line_id"], "name": l["name"]}
        loads = [(c["used"] / c["capacity"], c) for c in l["capacities"] if c["capacity"] > 0]
        top = max(loads, key=lambda x: x[0]) if loads else None
        if top and top[0] >= LOAD_HIGH:
            add("chain_bottleneck", ent, 0, 100 * top[0], top[1])
        elif l["need"] > 0 and (l["status"] == "none" or l["moved"] < l["need"] * SHIPPED_LOW):
            add("chain_bottleneck", ent, 1, l["need"] - l["moved"])
        if (l.get("cargo_total") or 0) >= LATE_MIN and (l.get("cargo_bad") or 0) / l["cargo_total"] > LATE_SHARE:
            add("chain_bottleneck", ent, 2, 100 * l["cargo_bad"] / l["cargo_total"])
        if loads and (l.get("vehicles") or 0) >= 2:
            low = max(x[0] for x in loads)
            if low < LOAD_LOW:
                add("chain_overcapacity", ent, 0, 100 * low)
    for n in view["nodes"]:
        if n["kind"] != "industry":
            continue
        if n.get("closure_time"):
            add("chain_industry", n, 1)
        elif n.get("producing") == 0 and n["outputs"]:
            add("chain_industry", n, 0)
        elif n["outputs"] and n["utilization"] < PROD_LOW and any(o["max"] > 0 for o in n["outputs"]):
            add("chain_industry", n, 3, 100 * n["utilization"])
        if n.get("thrown_away"):
            add("chain_industry", n, 2, n["thrown_away"])
        for i in n["inputs"]:
            if i["max"] > 0 and i["rate"] / i["max"] < INPUT_LOW:
                add("chain_input_short", n, 0, 100 * i["rate"] / i["max"], i)
    return out
