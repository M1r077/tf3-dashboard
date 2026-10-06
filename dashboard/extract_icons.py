"""Extract UI icons from the Transport Fever 3 game archives into dashboard/static/icons/*.png.

Grayscale TGA icons (the game tints them at runtime) are converted to white-on-transparent PNG
(alpha = luminance) so the dashboard can recolor them with CSS masks. Colored icons (cargo) are
copied as RGBA PNG.

Usage: python extract_icons.py [--game "C:\\...\\Transport Fever 3"] [--out static/icons]
The game folder is auto-detected from the Steam library folders when --game is omitted.
Stdlib only (own TGA decoder + PNG writer): the icons are read from YOUR game installation at first start,
they are not distributed with the dashboard.
"""
from __future__ import annotations

import argparse
import struct
import sys
import zipfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "collector"))
import tf3paths  # noqa: E402


# ---------------------------------------------------------------- minimal TGA -> RGBA + PNG writer (stdlib)
class Image:
    """Tiny RGBA raster with the two methods this script needs (open from TGA bytes, save as PNG)."""

    def __init__(self, w: int, h: int, rgba: bytearray, gray: bool):
        self.size = (w, h)
        self.rgba = rgba
        self.gray = gray  # True when the source was a grayscale TGA (the game tints these at runtime)

    @staticmethod
    def open(data: bytes) -> "Image":
        if len(data) < 18:
            raise ValueError("not a TGA")
        idlen, cmap_type, img_type, _cm_first, _cm_len, _cm_bpp, _x0, _y0, w, h, bpp, desc = struct.unpack(
            "<BBBHHBHHHHBB", data[:18])
        if cmap_type != 0 or img_type not in (2, 3, 10, 11) or bpp not in (8, 16, 24, 32):
            raise ValueError(f"unsupported TGA type={img_type} bpp={bpp} cmap={cmap_type}")
        bpp_bytes = bpp // 8
        off = 18 + idlen
        n = w * h
        if img_type >= 9:  # RLE
            px = bytearray()
            i = off
            while len(px) < n * bpp_bytes:
                hdr = data[i]; i += 1
                cnt = (hdr & 0x7F) + 1
                if hdr & 0x80:
                    px += data[i:i + bpp_bytes] * cnt; i += bpp_bytes
                else:
                    px += data[i:i + cnt * bpp_bytes]; i += cnt * bpp_bytes
            px = px[: n * bpp_bytes]
        else:
            px = bytearray(data[off: off + n * bpp_bytes])
        gray = img_type in (3, 11)
        out = bytearray(n * 4)
        if gray and bpp == 8:
            out[0::4] = px; out[1::4] = px; out[2::4] = px; out[3::4] = b"\xff" * n
        elif gray and bpp == 16:  # luminance + alpha
            out[0::4] = px[0::2]; out[1::4] = px[0::2]; out[2::4] = px[0::2]; out[3::4] = px[1::2]
        elif bpp == 24:  # BGR
            out[0::4] = px[2::3]; out[1::4] = px[1::3]; out[2::4] = px[0::3]; out[3::4] = b"\xff" * n
        elif bpp == 32:  # BGRA
            out[0::4] = px[2::4]; out[1::4] = px[1::4]; out[2::4] = px[0::4]; out[3::4] = px[3::4]
        else:
            raise ValueError(f"unsupported TGA bpp={bpp} gray={gray}")
        if not (desc & 0x20):  # origin bottom-left -> flip rows
            row = w * 4
            out = bytearray(b"".join(out[r * row:(r + 1) * row] for r in range(h - 1, -1, -1)))
        return Image(w, h, out, gray)

    def white_mask(self) -> "Image":
        """White-on-transparent: alpha = luminance (for CSS mask recoloring)."""
        n = self.size[0] * self.size[1]
        out = bytearray(n * 4)
        out[0::4] = b"\xff" * n; out[1::4] = b"\xff" * n; out[2::4] = b"\xff" * n
        out[3::4] = self.rgba[0::4]
        return Image(self.size[0], self.size[1], out, False)

    def save(self, path: Path) -> None:
        w, h = self.size
        raw = b"".join(b"\x00" + bytes(self.rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))

        def chunk(tag: bytes, body: bytes) -> bytes:
            return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

        png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
        Path(path).write_bytes(png)


def find_game() -> Path | None:
    """Transport Fever 3 install folder: every Steam library (libraryfolders.vdf), then the default one."""
    import re
    for root in tf3paths.steam_roots():
        libs = [root]
        vdf = root / "steamapps" / "libraryfolders.vdf"
        try:
            libs += [Path(p.replace("\\\\", "\\")) for p in re.findall(r'"path"\s+"([^"]+)"', vdf.read_text(encoding="utf-8", errors="replace"))]
        except OSError:
            pass
        for lib in libs:
            g = lib / "steamapps" / "common" / "Transport Fever 3"
            if (g / "base" / "content" / "gui.zip").exists():
                return g
    cfg = tf3paths.load_config().get("game_dir")
    if cfg and (Path(cfg) / "base" / "content" / "gui.zip").exists():
        return Path(cfg)
    return None

# output name -> (zip relative to base/content, path inside zip)
GUI = "gui.zip"
GM = "game_mechanics.zip"
ICONS: dict[str, tuple[str, str]] = {
    # vehicle types (VehicleIconType)
    "veh_bus": (GUI, "gui/hud/icons/vehicle_bus@2x.tga"),
    "veh_truck": (GUI, "gui/hud/icons/vehicle_truck@2x.tga"),
    "veh_train": (GUI, "gui/hud/icons/vehicle_train@2x.tga"),
    "veh_tram": (GUI, "gui/hud/icons/vehicle_tram@2x.tga"),
    "veh_plane": (GUI, "gui/hud/icons/vehicle_airplane@2x.tga"),
    "veh_heli": (GUI, "gui/hud/icons/vehicle_helicopter@2x.tga"),
    "veh_ship": (GUI, "gui/hud/icons/vehicle_ship@2x.tga"),
    "veh_car": (GUI, "gui/layers/icons/vehicle_cars@2x.tga"),
    "engine_steam": (GUI, "gui/line_vehicle_mgmt/icons/steam@2x.tga"),
    "engine_electric": (GUI, "gui/line_vehicle_mgmt/icons/electric@2x.tga"),
    "engine_diesel": (GUI, "gui/line_vehicle_mgmt/icons/diesel@2x.tga"),
    # condition (maintenance) 1..5
    "cond_1": (GUI, "gui/line_vehicle_mgmt/icons/condition_very_bad@2x.tga"),
    "cond_2": (GUI, "gui/line_vehicle_mgmt/icons/condition_bad@2x.tga"),
    "cond_3": (GUI, "gui/line_vehicle_mgmt/icons/condition_mediocre@2x.tga"),
    "cond_4": (GUI, "gui/line_vehicle_mgmt/icons/condition_good@2x.tga"),
    "cond_5": (GUI, "gui/line_vehicle_mgmt/icons/condition_very_good@2x.tga"),
    # buildings / entities
    "depot": (GUI, "gui/hud/icons/building_depot_32@2x.tga"),
    "depot_rail": (GUI, "gui/hud/icons/building_depot_train_32@2x.tga"),
    "depot_road": (GUI, "gui/hud/icons/building_depot_bus_truck_32@2x.tga"),
    "depot_tram": (GUI, "gui/hud/icons/building_depot_tram_32@2x.tga"),
    "depot_water": (GUI, "gui/hud/icons/building_depot_ship_32@2x.tga"),
    "depot_air": (GUI, "gui/hud/icons/building_depot_airplane_32@2x.tga"),
    "station": (GUI, "gui/entity_window/icons/building_stations@2x.tga"),
    "town": (GUI, "gui/entity_window/icons/building_town@2x.tga"),
    "industry": (GUI, "gui/entity_window/icons/building_industry@2x.tga"),
    "line": (GUI, "gui/game_bar/icons/statistics_line@2x.tga"),
    "vehicles": (GUI, "gui/game_bar/icons/statistics_vehicle@2x.tga"),
    "stat_station": (GUI, "gui/game_bar/icons/statistics_station@2x.tga"),
    "stat_town": (GUI, "gui/game_bar/icons/statistics_town@2x.tga"),
    "stat_industry": (GUI, "gui/game_bar/icons/statistics_industry@2x.tga"),
    "stat_depot": (GUI, "gui/game_bar/icons/statistics_depot@2x.tga"),
    "line_stations": (GUI, "gui/line_vehicle_mgmt/icons/line_stations@2x.tga"),
    # symbols
    "alert": (GUI, "gui/menu/icons/alert@2x.tga"),
    "warning": (GUI, "gui/hud/icons/line_vehicle_warning@2x.tga"),
    "calendar": (GUI, "gui/menu/icons/calendar@2x.tga"),
    "clock": (GUI, "gui/entity_window/icons/symbol_stop_watch@2x.tga"),
    "speed": (GUI, "gui/entity_window/icons/symbol_speed@2x.tga"),
    "game_speed": (GUI, "gui/camera_tool/icons/game_speed@2x.tga"),
    "cargo": (GUI, "gui/entity_window/icons/symbol_cargo@2x.tga"),
    "passengers": (GUI, "gui/entity_window/icons/passengers@2x.tga"),
    "person": (GUI, "gui/line_vehicle_mgmt/icons/symbol_person@2x.tga"),
    "unhappy": (GUI, "gui/entity_window/icons/unhappy_passenger@2x.tga"),
    "terminal_full": (GUI, "gui/entity_window/icons/terminal_full@2x.tga"),
    "wrench": (GUI, "gui/line_vehicle_mgmt/icons/symbol_wrench@2x.tga"),
    "maintenance": (GUI, "gui/line_vehicle_mgmt/icons/maintenance_costs@2x.tga"),
    "money": (GUI, "gui/construction/menu/symbol_coin_stack@2x.tga"),
    "running_cost": (GUI, "gui/entity_window/icons/symbol_dollar_gear@2x.tga"),
    "income": (GUI, "gui/entity_window/icons/symbol_dollar_arrow@2x.tga"),
    "chart": (GM, "game_mechanics/finance/icons/symbol_chart_arrow_up@2x.tga"),
    "locate": (GUI, "gui/line_vehicle_mgmt/icons/symbol_locate@2x.tga"),
    "eye": (GUI, "gui/line_vehicle_mgmt/icons/symbol_eye@2x.tga"),
    "info": (GUI, "gui/line_vehicle_mgmt/icons/symbol_info_outline@2x.tga"),
    "check": (GUI, "gui/entity_window/icons/circle_check@2x.tga"),
    "empty": (GUI, "gui/line_vehicle_mgmt/icons/empty_list@2x.tga"),
    "noise": (GUI, "gui/line_vehicle_mgmt/icons/symbol_noise@2x.tga"),
    "pollution": (GUI, "gui/line_vehicle_mgmt/icons/symbol_pollution@2x.tga"),
    "reputation": (GUI, "gui/entity_window/icons/town_reputation@2x.tga"),
    "town_people": (GUI, "gui/entity_window/icons/town_people.tga"),
    "town_workplaces": (GUI, "gui/entity_window/icons/town_workplaces.tga"),
    "town_shopping": (GUI, "gui/entity_window/icons/town_shopping.tga"),
    "town_happiness": (GUI, "gui/entity_window/icons/town_happiness.tga"),
    "town_supplies": (GUI, "gui/entity_window/icons/town_supplies@2x.tga"),
    "town_growth": (GUI, "gui/entity_window/icons/town_growth_rate_up@2x.tga"),
    "cargo_received": (GUI, "gui/entity_window/icons/symbol_cargo_received@2x.tga"),
    "cargo_supplied": (GUI, "gui/entity_window/icons/symbol_cargo_supplied@2x.tga"),
    "production": (GUI, "gui/entity_window/icons/production_arrow@2x.tga"),
    "stop": (GUI, "gui/entity_window/icons/stop@2x.tga"),
    "arrow_up": (GUI, "gui/entity_window/icons/symbol_arrow_up@2x.tga"),
    "refresh": (GUI, "gui/entity_window/icons/symbol_arrows_refresh@2x.tga"),
    "load_speed": (GUI, "gui/line_vehicle_mgmt/icons/stat_load_speed@2x.tga"),
    "weight": (GUI, "gui/line_vehicle_mgmt/icons/symbol_weight@2x.tga"),
    "train_length": (GUI, "gui/line_vehicle_mgmt/icons/relation_train_length@2x.tga"),
    "cargo_time": (GUI, "gui/line_vehicle_mgmt/icons/relation_cargo_time@2x.tga"),
    # game control / camera
    "play_pause": (GUI, "gui/game_bar/icons/playback_pause@2x.tga"),
    "play_1": (GUI, "gui/game_bar/icons/playback_play@2x.tga"),
    "play_2": (GUI, "gui/game_bar/icons/playback_play_2@2x.tga"),
    "play_4": (GUI, "gui/game_bar/icons/playback_play_4@2x.tga"),
    "camera": (GUI, "gui/game_bar/icons/symbol_camera@2x.tga"),
    "follow": (GUI, "gui/camera_tool/icons/camera@2x.tga"),
    "reverse": (GUI, "gui/entity_window/icons/symbol_arrow_reverse@2x.tga"),
    "depart": (GUI, "gui/line_vehicle_mgmt/icons/symbol_arrow_circle_dot@2x.tga"),
    "to_depot": (GUI, "gui/entity_window/icons/building_depot_arrow@2x.tga"),
    "power": (GUI, "gui/line_vehicle_mgmt/icons/symbol_circle_on_off@2x.tga"),
    "language": (GUI, "gui/menu/icons/symbol_star_outline@2x.tga"),
    "settings": (GUI, "gui/main/icons/symbol_gear_28@2x.tga"),
    "close": (GUI, "gui/builtin/window/icons/cross_thin@2x.tga"),
    # layout edit mode
    "edit": (GUI, "gui/builtin/window/icons/symbol_pencil@2x.tga"),
    "configure_line": (GUI, "gui/entity_window/icons/symbol_configure_line@2x.tga"),
    # departure configuration (load modes) - same icons as the game's cargo filter window
    "load_available": (GUI, "gui/line_vehicle_mgmt/icons/load-mode_available@2x.tga"),
    "load_full_any": (GUI, "gui/line_vehicle_mgmt/icons/load-mode_full-any@2x.tga"),
    "load_full_all": (GUI, "gui/line_vehicle_mgmt/icons/load-mode_full-all@2x.tga"),
    "prio_standard": (GUI, "gui/entity_window/icons/prio_standard@2x.tga"),
    "prio_high": (GUI, "gui/entity_window/icons/prio_high@2x.tga"),
    "prio_very_high": (GUI, "gui/entity_window/icons/prio_very_high@2x.tga"),
    "select": (GUI, "gui/cursors/default@2x.tga"),
    "drag": (GUI, "gui/line_vehicle_mgmt/icons/drag_vertical_20@2x.tga"),
    "hidden": (GUI, "gui/menu/icons/mod_management/mod-invisible@2x.tga"),
    "reset": (GUI, "gui/menu/icons/reset@2x.tga"),
    "lock": (GUI, "gui/builtin/window/icons/lock@2x.tga"),
    # terminals (platform selection per stop)
    "star": (GUI, "gui/menu/icons/symbol_star@2x.tga"),
    "star_outline": (GUI, "gui/menu/icons/symbol_star_outline@2x.tga"),
    "terminal": (GUI, "gui/line_vehicle_mgmt/icons/indicator_terminal_20@2x.tga"),
    "plus": (GUI, "gui/camera_tool/icons/plus19.tga"),
    # notifications (alerts)
    "no_path": (GM, "game_mechanics/notifications/gui/icons/no_road_connection@2x.tga"),
    "stock_full": (GM, "game_mechanics/notifications/gui/icons/cargo_full_stock@2x.tga"),
    "line_no_stations": (GM, "game_mechanics/notifications/gui/icons/line_minus_stations@2x.tga"),
    "line_incompatible": (GM, "game_mechanics/notifications/gui/icons/line_station_incompatible@2x.tga"),
    "line_problem": (GM, "game_mechanics/notifications/gui/icons/line_minus_x@2x.tga"),
    "line_unload": (GM, "game_mechanics/notifications/gui/icons/line_cargo_minus_unload@2x.tga"),
    "town_up": (GM, "game_mechanics/notifications/gui/icons/building_town_arrow_up@2x.tga"),
    "industry_up": (GM, "game_mechanics/notifications/gui/icons/building_industry_plus@2x.tga"),
    "industry_down": (GM, "game_mechanics/notifications/gui/icons/building_industry_x@2x.tga"),
    "industry_closed": (GM, "game_mechanics/notifications/gui/icons/building_industry_bulldozer@2x.tga"),
}


def to_png(data: bytes) -> Image:
    im = Image.open(data)
    return im.white_mask() if im.gray else im


def extract(game: Path, out: Path) -> int:
    base = game / "base" / "content"
    out.mkdir(parents=True, exist_ok=True)
    (out / "cargo").mkdir(exist_ok=True)
    zips: dict[str, zipfile.ZipFile] = {}

    def zf(name: str) -> zipfile.ZipFile:
        if name not in zips:
            zips[name] = zipfile.ZipFile(base / name)
        return zips[name]

    n = 0
    missing = []
    for key, (zname, path) in ICONS.items():
        try:
            data = zf(zname).read(path)
        except KeyError:
            missing.append(path)
            continue
        to_png(data).save(out / f"{key}.png")
        n += 1

    # cargo icons: cargos/<name>.zip -> <name>/<name>@2x.tga (colored)
    cargo_dir = base / "cargos"
    for z in sorted(cargo_dir.glob("*.zip")):
        if z.stem in ("classes", "formats", "shared"):
            continue
        if z.stem == "icons":  # cargos/icons.zip holds the generic "mixed cargo" icon
            with zipfile.ZipFile(z) as c:
                to_png(c.read("icons/cargo_mixed@2x.tga")).save(out / "cargo" / "_mixed.png")
            n += 1
            continue
        try:
            with zipfile.ZipFile(z) as c:
                cands = [i for i in c.namelist() if i.lower().endswith(".tga") and "/" in i and i.count("/") == 1]
                pick = next((i for i in cands if "@2x" in i), cands[0] if cands else None)
                if not pick:
                    missing.append(f"{z.name}: no icon")
                    continue
                to_png(c.read(pick)).save(out / "cargo" / f"{z.stem}.png")
                n += 1
        except zipfile.BadZipFile:
            missing.append(z.name)
    # passengers as cargo id 0: cargos/passengers.zip holds the colored (yellow) figure the game uses in cargo
    # lists; fall back to the white UI symbol only if that archive is missing.
    if not (out / "cargo" / "passengers.png").exists() and (out / "passengers.png").exists():
        (out / "cargo" / "passengers.png").write_bytes((out / "passengers.png").read_bytes())
    # cargo classes (terminal specialisation chips): cargos/classes.zip -> classes/<class>@2x.tga (white symbols)
    (out / "cargo_class").mkdir(exist_ok=True)
    try:
        with zipfile.ZipFile(cargo_dir / "classes.zip") as c:
            for name in c.namelist():
                if name.endswith("@2x.tga"):
                    to_png(c.read(name)).save(out / "cargo_class" / (Path(name).name[: -len("@2x.tga")] + ".png"))
                    n += 1
    except (FileNotFoundError, zipfile.BadZipFile):
        missing.append("cargos/classes.zip")

    n += extract_vehicles(game, out)

    for z in zips.values():
        z.close()
    if missing:
        print("missing:", *missing, sep="\n  ", file=sys.stderr)
    return n


# Vehicle model icons (colored, side view, 56x40 "icon20@2x"), one per .mdl, from the base game and the DLCs.
# Output: icons/vehicles/<category>/<model stem>.png (+ _manifest.json listing what exists), keyed by the
# model resource name without extension: "vehicle/train/alco_hh600.mdl" -> "train/alco_hh600".
# The game itself has no icon for private cars (the "car" category), they are skipped.
ICON_SUFFIX = "_icon20@2x.tga"
VEH_CATS = ("bus", "truck", "tram", "train", "waggon", "plane", "helicopter", "zeppelin", "ship")


def _vehicle_icons_in_zip(zf: zipfile.ZipFile, prefix: str) -> dict[str, str]:
    """Return {"<cat>/<stem>": "<path in zip>"} for every colored side icon. prefix = "" (per-vehicle zips) or
    "vehicle/" (DLC bundles where the path is vehicle/<cat>/<folder>/icons/<stem>_icon20@2x.tga)."""
    out: dict[str, str] = {}
    for name in zf.namelist():
        if not name.endswith(ICON_SUFFIX) or "_cblend" in name:
            continue
        rel = name[len(prefix):] if prefix and name.startswith(prefix) else name
        parts = rel.split("/")
        # per-vehicle zip: <folder>/icons/<stem>_icon20@2x.tga  (category comes from the zip's parent dir)
        # DLC bundle:      <cat>/<folder>/icons/<stem>_icon20@2x.tga
        if len(parts) < 3 or parts[-2] != "icons":
            continue
        stem = parts[-1][: -len(ICON_SUFFIX)]
        cat = parts[0] if len(parts) >= 4 else None
        out[(cat or "") + "/" + stem] = name
    return out


def extract_vehicles(game: Path, out: Path) -> int:
    import json

    vout = out / "vehicles"
    vout.mkdir(exist_ok=True)
    manifest: dict[str, str] = {}  # "train/alco_hh600" -> "train/alco_hh600.png"

    def save(key: str, data: bytes) -> None:
        cat, stem = key.split("/", 1)
        (vout / cat).mkdir(exist_ok=True)
        to_png(data).save(vout / cat / f"{stem}.png")
        manifest[key] = f"{cat}/{stem}.png"

    # base game: base/content/vehicle/<cat>/<model>.zip
    for cat in VEH_CATS:
        for z in sorted((game / "base" / "content" / "vehicle" / cat).glob("*.zip")):
            try:
                with zipfile.ZipFile(z) as c:
                    for key, path in _vehicle_icons_in_zip(c, "").items():
                        save(f"{cat}/{key.split('/', 1)[1]}", c.read(path))
            except zipfile.BadZipFile:
                print("bad zip:", z, file=sys.stderr)
    # DLCs: dlcs/<dlc>/content/vehicle.zip with paths vehicle/<cat>/<folder>/icons/...
    for z in sorted((game / "dlcs").glob("*/content/vehicle.zip")):
        try:
            with zipfile.ZipFile(z) as c:
                for key, path in _vehicle_icons_in_zip(c, "vehicle/").items():
                    if key.startswith("/"):
                        continue
                    save(key, c.read(path))
        except zipfile.BadZipFile:
            print("bad zip:", z, file=sys.stderr)
    # user mods (Steam workshop / local mods) are not scanned: their icons would need the mod folder layout.
    (vout / "_manifest.json").write_text(json.dumps(dict(sorted(manifest.items())), indent=0), encoding="utf-8")
    print(f"{len(manifest)} vehicle icons -> {vout}")
    return len(manifest)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default=None, help="Transport Fever 3 install folder (default: auto-detect from Steam)")
    ap.add_argument("--out", default=str(Path(__file__).parent / "static" / "icons"))
    a = ap.parse_args()
    game = Path(a.game) if a.game else find_game()
    if game is None or not (game / "base" / "content" / "gui.zip").exists():
        print("Transport Fever 3 installation not found. Pass --game \"<folder containing base\\content\\gui.zip>\"\n"
              "or add  \"game_dir\": \"...\"  to config.json. The dashboard works without icons (text fallback).",
              file=sys.stderr)
        return 1
    print(f"game: {game}")
    out = Path(a.out)
    n = extract(game, out)
    import json
    (out / "_manifest.json").write_text(json.dumps({"game": str(game), "icons": n}), encoding="utf-8")
    print(f"{n} icons -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
