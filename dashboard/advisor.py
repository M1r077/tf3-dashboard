"""Advice for the player, from what the database already holds (0.4.2):

- fleet renewal: vehicles whose model is withdrawn, that are worn out, or for which a clearly better model of the
  same kind is on sale now, grouped by (current model, suggested model);
- town demand: cargo a town needs and does not get, with the nearest industry producing it;
- "what to do now": one prioritised to-do list merging the alerts (game and supply chains), the fleet state, the
  renewal groups and the town demand.

Pure functions over plain dicts (rows of the server's queries); the wording is done by the page (i18n), so every item
carries a language-neutral `kind` and its parameters.
"""
from __future__ import annotations

import math
from typing import Any

WORN = 0.35            # condition below which a vehicle is worn out
GAIN_MIN = 0.25        # a successor must be this much better (speed or capacity / power)
DEMAND_SHARE = 0.5     # a town gets less than this share of what it needs = unmet demand
NEED_MIN = 10          # ... and needs at least this much per year


def _f(v: Any) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def category(key: str | None) -> str | None:
    return key.split("/")[0] if key and "/" in key else None


# ---------------------------------------------------------------- fleet renewal
def _available(m: dict, year: int) -> bool:
    return (m.get("year_from") or 0) <= year and (not m.get("year_to") or m["year_to"] >= year)


def _cargo_set(m: dict) -> set:
    return {c for c in str(m.get("cargo") or "").split(",") if c}


def _gain(cur: dict, cand: dict) -> tuple[float, float, float]:
    """(speed gain, capacity-or-power gain, score); trains are compared on their locomotive: speed and power."""
    sp = _f(cand.get("speed_ms")) / _f(cur.get("speed_ms")) - 1 if _f(cur.get("speed_ms")) > 0 and _f(cand.get("speed_ms")) > 0 else 0.0
    if category(cur.get("model_key")) == "train":
        a, b = _f(cur.get("power_kw")), _f(cand.get("power_kw"))
    else:
        a, b = _f(cur.get("capacity")), _f(cand.get("capacity"))
    cp = b / a - 1 if a > 0 and b > 0 else 0.0
    return sp, cp, sp + cp


def successor(cur: dict, catalogue: list[dict], year: int) -> dict | None:
    """Best model of the same kind on sale now, newer, at least GAIN_MIN better and not slower / smaller than 10 %."""
    cat = category(cur.get("model_key"))
    if not cat or cat == "waggon":
        return None
    cur_cargo = _cargo_set(cur)
    best, best_score = None, 0.0
    for m in catalogue:
        if m.get("multiple_unit") is not None or m.get("model_key") == cur.get("model_key") or category(m.get("model_key")) != cat:
            continue
        if not _available(m, year) or (m.get("year_from") or 0) <= (cur.get("year_from") or 0):
            continue
        if cur_cargo and _cargo_set(m) and not (cur_cargo & _cargo_set(m)):
            continue  # a truck for another kind of cargo is no replacement
        sp, cp, score = _gain(cur, m)
        if sp < -0.1 or cp < -0.1 or max(sp, cp) < GAIN_MIN:
            continue
        if score > best_score:
            best, best_score = m, score
    if best is None:
        return None
    sp, cp, _ = _gain(cur, best)
    return {**best, "speed_gain": round(sp, 3), "capacity_gain": round(cp, 3), "gain_on": "power" if cat == "train" else "capacity"}


def renewal(vehicles: list[dict], catalogue: list[dict], year: int | None) -> list[dict]:
    """Groups of vehicles to renew: {model (catalogue row), successor, reasons, count, vehicle_ids, lines, condition}."""
    if year is None or not catalogue:
        return []
    by_key: dict[str, dict] = {}
    for m in catalogue:
        if m.get("multiple_unit") is None:
            by_key.setdefault(m["model_key"], m)
    succ_cache: dict[str, dict | None] = {}
    groups: dict[tuple, dict] = {}
    for v in vehicles:
        cur = by_key.get(v.get("model_key") or "")
        if not cur:
            continue  # model unknown to the catalogue (older mod, or a vehicle of a removed mod)
        withdrawn = bool(cur.get("year_to")) and cur["year_to"] < year
        worn = v.get("maintenance") is not None and v["maintenance"] < WORN
        if cur["model_key"] not in succ_cache:
            succ_cache[cur["model_key"]] = successor(cur, catalogue, year)
        succ = succ_cache[cur["model_key"]]
        if not (withdrawn or worn or succ):
            continue
        reasons = [r for r, on in (("withdrawn", withdrawn), ("worn", worn), ("outdated", succ is not None)) if on]
        k = (cur["model_key"], succ["model_key"] if succ else None, "worn" in reasons and not withdrawn and not succ)
        g = groups.setdefault(k, {"model": cur, "successor": succ, "reasons": set(), "vehicle_ids": [], "lines": {}, "cond": [],
                                  "carrier": v.get("carrier"), "icon_type": v.get("icon_type"), "worn": 0})
        g["reasons"].update(reasons)
        g["vehicle_ids"].append(v["vehicle_id"])
        g["worn"] += worn
        if v.get("maintenance") is not None:
            g["cond"].append(v["maintenance"])
        if v.get("line_id"):
            g["lines"][v["line_id"]] = v.get("line_name")
    out = []
    for g in groups.values():
        reasons = sorted(g["reasons"], key=["withdrawn", "worn", "outdated"].index)
        prio = 1 if "withdrawn" in reasons and "worn" in reasons else 2 if "withdrawn" in reasons or "worn" in reasons else 3
        out.append({"model": g["model"], "successor": g["successor"], "reasons": reasons, "priority": prio,
                    "count": len(g["vehicle_ids"]), "worn": g["worn"], "vehicle_ids": g["vehicle_ids"],
                    "lines": [{"line_id": k, "name": n} for k, n in g["lines"].items()],
                    "condition": round(sum(g["cond"]) / len(g["cond"]), 3) if g["cond"] else None,
                    "carrier": g["carrier"], "icon_type": g["icon_type"],
                    "cost": round(_f(g["successor"].get("price")) * len(g["vehicle_ids"])) if g["successor"] else None})
    out.sort(key=lambda g: (g["priority"], -g["count"]))
    return out


# ---------------------------------------------------------------- town demand
def town_demand(towns: list[dict], industries: list[dict]) -> list[dict]:
    """Cargo a town needs ("needed" of the town window) and gets less than DEMAND_SHARE of, with the nearest producer."""
    producers: dict[int, list[dict]] = {}
    for i in industries:
        for c in i.get("cargo") or []:
            if c.get("direction") == "out" and i.get("x") is not None:
                producers.setdefault(c["cargo_id"], []).append({"industry_id": i["industry_id"], "name": i.get("name"), "x": i["x"], "y": i["y"],
                                                                 "produced": _f(c.get("produced_year")), "shipped": _f(c.get("shipped_year"))})
    out = []
    for t in towns:
        for c in t.get("cargo") or []:
            need, got = _f(c.get("needed")), _f(c.get("supplied"))
            if need < NEED_MIN or got >= need * DEMAND_SHARE:
                continue
            near = None
            if t.get("x") is not None:
                cands = sorted(producers.get(c["cargo_id"], []), key=lambda p: math.hypot(p["x"] - t["x"], p["y"] - t["y"]))
                if cands:
                    p = cands[0]
                    near = {**{k: p[k] for k in ("industry_id", "name", "produced", "shipped")}, "km": round(math.hypot(p["x"] - t["x"], p["y"] - t["y"]) / 1000, 1)}
            out.append({"town_id": t["town_id"], "town": t.get("name"), "cargo_id": c["cargo_id"], "cargo": c.get("cargo"), "cargo_key": c.get("cargo_key"),
                        "needed": round(need), "supplied": round(got), "missing": round(need - got), "producer": near})
    out.sort(key=lambda d: -d["missing"])
    return out


# ---------------------------------------------------------------- what to do now
GAME_LINE = ("line_problem",)
GAME_VEHICLE = ("vehicle_problem", "no_path_vehicle", "blocked_train")


def todo(alerts: list[dict], fleet: dict, renewal_groups: list[dict], demand: list[dict], limit: int = 12) -> list[dict]:
    """Prioritised to-do items: {prio 1 urgent / 2 important / 3 suggestion, kind, params, tab, entity}."""
    items: list[dict] = []

    def add(prio: int, kind: str, tab: str, entity: Any = None, **params):
        items.append({"prio": prio, "kind": kind, "tab": tab, "entity": entity, "params": params})

    veh_problems = [a for a in alerts if a.get("kind") in GAME_VEHICLE]
    if veh_problems:
        add(1, "vehicles_blocked", "vehicles", None, n=len({a.get("entity_id") for a in veh_problems}))
    for a in alerts:
        k, name = a.get("kind"), a.get("entity_name") or ""
        if k in GAME_LINE:
            add(1, "line_problem", "lines", a.get("entity_id"), name=name, code=a.get("type_code"))
        elif k == "closing_industry":
            add(2, "industry_closing", "industries", a.get("entity_id"), name=name)
        elif k == "chain_bottleneck":
            code = a.get("type_code")
            add(1 if code == 1 else 2, f"chain_bottleneck_{code}", "chains", a.get("entity_id"), name=name, n=a.get("amount"), cargo=a.get("cargo"))
        elif k == "chain_overcapacity":
            add(3, "chain_overcapacity", "lines", a.get("entity_id"), name=name, n=a.get("amount"))
        elif k == "chain_industry" and a.get("type_code") in (0, 1):
            add(1 if a.get("type_code") == 0 else 2, f"chain_industry_{a.get('type_code')}", "industries", a.get("entity_id"), name=name)
        elif k == "chain_input_short":
            add(2, "chain_input_short", "chains", a.get("entity_id"), name=name, n=a.get("amount"), cargo=a.get("cargo"))
    if fleet.get("worn_bad"):
        add(2, "vehicles_worn", "vehicles", None, n=fleet["worn_bad"])
    if fleet.get("idle"):
        add(3, "vehicles_idle", "vehicles", None, n=fleet["idle"])
    # worn-only groups without a better model are maintenance, already counted by "vehicles_worn"
    for g in [g for g in renewal_groups if g["successor"] or "withdrawn" in g["reasons"]][:3]:
        s = g["successor"]
        add(g["priority"] if g["priority"] < 3 else 3, "renew" if s else "renew_none", "vehicles", None, n=g["count"],
            model=g["model"].get("name") or g["model"]["model_key"], to=(s.get("name") or s["model_key"]) if s else None,
            reasons=g["reasons"])
    for d in demand[:3]:
        add(3, "town_demand", "towns", d["town_id"], town=d["town"], cargo=d["cargo"], a=d["supplied"], b=d["needed"],
            producer=(d["producer"] or {}).get("name"), km=(d["producer"] or {}).get("km"))
    items.sort(key=lambda i: i["prio"])  # stable: within a priority, the order above (game first, then chains, fleet...)
    return items[:limit]
