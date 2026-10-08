"""Locate the Transport Fever 3 userdata folder where the mod writes its live file (and reads commands).

Resolution order:
  1. ROOT/config.json  -> {"export_dir": "...", "port": 8765}   (written by the user, optional)
  2. environment TF3_EXPORT_DIR
  3. Steam: <SteamPath>/userdata/<any id>/3493540/local/towns_industries   (registry, then default folders)
  4. Epic / GOG (Windows): %APPDATA%/Transport Fever 3/towns_industries  (the game keeps save/, settings.lua,
     profile.lua there when it is not the Steam build; %LOCALAPPDATA% is scanned too, best effort)
  5. macOS: ~/Library/Application Support/Transport Fever 3 ; Linux: ~/.local/share/Transport Fever 3
When several candidates exist, the one whose live file was modified most recently wins; a candidate whose
export folder does not exist yet is kept (ensure_export_dir creates it: the game does not always).
game_log() reads the game's own crash_dump/stdout.txt to cross-check: which userdata folder the game really uses,
whether the mod was loaded and whether its writes succeeded.
Stdlib only.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent      # the TF3 Dashboard folder
CONFIG = ROOT / "config.json"
APP_ID = "3493540"
# Game build 40420 (8 Oct 2026) only lets mods write to three userdata folders (heightmaps, mod_presets,
# towns_industries). Mod rev 9 therefore writes to towns_industries with a tf3dash_ prefix; up to rev 8 the files were
# live.lua, slow_*.lua, cmd.lua, activity.lua in a dashboard_export folder. The companion handles both layouts: the
# one whose live file is the most recent wins (candidate_export_dirs), and commands are written where live is read.
EXPORT_SUBDIR = "towns_industries"
FILE_PREFIX = "tf3dash_"
LEGACY_SUBDIR = "dashboard_export"
LEGACY_PREFIX = ""


def prefix_for(d: Path | None) -> str:
    """File name prefix used in folder d: tf3dash_ in towns_industries (rev 9+), none in dashboard_export (<= rev 8)."""
    return LEGACY_PREFIX if d is not None and d.name.lower() == LEGACY_SUBDIR else FILE_PREFIX


def live_name(d: Path | None) -> str:
    return prefix_for(d) + "live.lua"


def file_in(d: Path, name: str) -> Path:
    """<d>/<prefix><name>.lua for cmd, activity, slow_<section>."""
    return d / (prefix_for(d) + name + ".lua")
DEFAULT_DB = ROOT / "db" / "tf3_dashboard.db"
DEFAULT_PORT = 8765


def version() -> str:
    """Companion version: the VERSION = "x.y.z" line of dashboard/server.py (single source, also read by
    build_release.cmd); the collector must not import the server to know it."""
    try:
        with open(ROOT / "dashboard" / "server.py", encoding="utf-8") as f:
            for line in f:
                if line.startswith("VERSION = "):
                    return line.split('"')[1]
    except (OSError, IndexError):
        pass
    return "?"


def load_config() -> dict:
    try:
        with open(CONFIG, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def steam_roots() -> list[Path]:
    roots: list[Path] = []
    if sys.platform == "win32":
        try:
            import winreg
            for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                              (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam"),
                              (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam")):
                try:
                    with winreg.OpenKey(hive, key) as k:
                        for name in ("SteamPath", "InstallPath"):
                            try:
                                v, _ = winreg.QueryValueEx(k, name)
                                if v:
                                    roots.append(Path(str(v)))
                            except OSError:
                                pass
                except OSError:
                    pass
        except ImportError:
            pass
        for env in ("ProgramFiles(x86)", "ProgramFiles"):
            base = os.environ.get(env)
            if base:
                roots.append(Path(base) / "Steam")
    else:
        home = Path.home()
        roots += [home / ".steam" / "steam", home / ".local" / "share" / "Steam",
                  home / "Library" / "Application Support" / "Steam"]
    seen: set[str] = set()
    out: list[Path] = []
    for r in roots:
        key = str(r).lower()
        if key not in seen and r.is_dir():
            seen.add(key)
            out.append(r)
    return out


def userdata_roots() -> list[tuple[str, Path]]:
    """Every folder that may be the game's userdata root on this machine, as (store, path). Only folders that
    exist are returned (the game creates its userdata folder at the first start), the export subfolder
    may not exist yet."""
    roots: list[tuple[str, Path]] = []
    for root in steam_roots():
        ud = root / "userdata"
        if ud.is_dir():
            for acct in ud.iterdir():
                local = acct / APP_ID / "local"
                if local.is_dir():
                    roots.append(("Steam", local))
    if sys.platform == "win32":
        # Epic / GOG builds keep save/, settings.lua, profile.lua under %APPDATA%\Transport Fever 3
        for env in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if not base:
                continue
            for name in ("Transport Fever 3", "TransportFever3"):
                p = Path(base) / name
                if p.is_dir():
                    roots.append(("Epic/GOG", p))
                    for d in p.iterdir():
                        if d.is_dir() and (d.name == "local" or (d / EXPORT_SUBDIR).is_dir() or (d / LEGACY_SUBDIR).is_dir()):
                            roots.append(("Epic/GOG", d))
    elif sys.platform == "darwin":
        p = Path.home() / "Library" / "Application Support" / "Transport Fever 3"
        if p.is_dir():
            roots.append(("macOS", p))
    else:
        p = Path.home() / ".local" / "share" / "Transport Fever 3"
        if p.is_dir():
            roots.append(("Linux", p))
    return roots


def candidate_export_dirs() -> list[Path]:
    """All export folders that exist (or could exist) on this machine, most recent first: towns_industries (rev 9+)
    and the legacy dashboard_export (<= rev 8) of every userdata root. A towns_industries folder without our files
    ranks above an empty legacy folder; a legacy folder with a recent live.lua (old mod still running) ranks first."""
    cands: list[Path] = []
    for _, root in userdata_roots():
        cands.append(root / EXPORT_SUBDIR)
        cands.append(root / LEGACY_SUBDIR)

    def mtime(d: Path) -> float:
        try:
            return (d / live_name(d)).stat().st_mtime
        except OSError:
            return -1.0 if d.name.lower() == EXPORT_SUBDIR else -2.0

    uniq: dict[str, Path] = {}
    for c in cands:
        uniq.setdefault(str(c).lower(), c)
    return sorted(uniq.values(), key=mtime, reverse=True)


def export_dir(explicit: str | os.PathLike | None = None) -> Path | None:
    """The folder containing live.lua / cmd.lua, or None when nothing was found."""
    if explicit:
        return Path(explicit)
    cfg = load_config().get("export_dir")
    if cfg:
        return Path(str(cfg)).expanduser()
    env = os.environ.get("TF3_EXPORT_DIR")
    if env:
        return Path(env)
    cands = candidate_export_dirs()
    return cands[0] if cands else None


def live_path(explicit: str | os.PathLike | None = None) -> Path | None:
    """Path of the live file. `explicit` may be the file itself or its folder."""
    if explicit and str(explicit).lower().endswith(".lua"):
        return Path(explicit)
    d = export_dir(explicit)
    return d / live_name(d) if d else None


def db_path(explicit: str | os.PathLike | None = None) -> Path:
    if explicit:
        return Path(explicit)
    cfg = load_config().get("db")
    if not cfg:
        return DEFAULT_DB
    p = Path(str(cfg)).expanduser()
    return p if p.is_absolute() else ROOT / p


def port(explicit: int | None = None) -> int:
    if explicit:
        return int(explicit)
    cfg = load_config().get("port")
    try:
        return int(cfg) if cfg else DEFAULT_PORT
    except (TypeError, ValueError):
        return DEFAULT_PORT


def ensure_export_dir(explicit: str | os.PathLike | None = None) -> list[Path]:
    """Create the export folder (towns_industries) wherever the game may look for it: the game creates it at its first
    start, but app.saveUserdata does not create a missing folder, so the companion does: one empty folder per existing
    userdata root (and the configured/explicit folder when its parent exists). Returns the folders created now."""
    targets = [r / EXPORT_SUBDIR for _, r in userdata_roots()]
    d = export_dir(explicit)
    if d and d.parent.is_dir():
        targets.append(d)
    created: list[Path] = []
    seen: set[str] = set()
    for t in targets:
        key = str(t).lower()
        if key in seen or t.is_dir():
            continue
        seen.add(key)
        try:
            t.mkdir()
            created.append(t)
        except OSError:
            pass
    return created


_LOG_CACHE: dict[str, tuple[tuple[int, int], dict]] = {}


def _parse_game_log(log: Path) -> dict | None:
    """What the game's own log says: which userdata folder it uses (line 5 of every stdout.txt), whether our mod was
    loaded and from where, how many snapshots it wrote and whether saveUserdata refused. Cached per (mtime, size)."""
    try:
        st = log.stat()
    except OSError:
        return None
    key = str(log).lower()
    sig = (int(st.st_mtime), st.st_size)
    hit = _LOG_CACHE.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    try:
        text = log.read_bytes().decode("utf-8", errors="replace")
    except OSError:
        return None
    info: dict = {"log": str(log), "log_mtime": st.st_mtime, "userdata": None, "build": None, "mod_loaded": False,
                  "mod_source": None, "mod_lines": 0, "written": 0, "save_errors": 0, "last_error": None,
                  "last_mod_line": None, "writes_to": None}
    for line in text.splitlines():
        if info["userdata"] is None and "User data folder:" in line:
            info["userdata"] = line.split("User data folder:", 1)[1].strip()
        elif info["build"] is None and "Starting up build version:" in line:
            try:
                info["build"] = int(line.split("build version:", 1)[1].split(",", 1)[0].strip())
            except ValueError:
                pass
        elif "tf3_dashboard_export" in line and "ModHubMod" in line:
            info["mod_loaded"] = True
            if "(source: " in line:
                info["mod_source"] = line.split("(source: ", 1)[1].split(")", 1)[0]
        elif "[dashboard_export]" in line:
            info["mod_lines"] += 1
            body = line.split("[dashboard_export]", 1)[1].strip()
            info["last_mod_line"] = body[:200]
            if "saveUserdata failed" in body:
                info["save_errors"] += 1
                info["last_error"] = body[:200]
            elif body.startswith("seq ") and " written" in body:
                info["written"] += 1
            elif body.startswith("writing ") and ".lua every" in body:
                # "writing towns_industries/tf3dash_live.lua every 2s (...)": the folder/file the mod actually uses
                info["writes_to"] = body.split(" ", 2)[1]
    _LOG_CACHE[key] = (sig, info)
    return info


def game_log(explicit: str | os.PathLike | None = None) -> dict | None:
    """The most recently written game log among all userdata folders on this PC (plus the watched one): that is the
    installation the player actually runs. None when no stdout.txt exists anywhere."""
    roots = [r for _, r in userdata_roots()]
    d = export_dir(explicit)
    if d is not None:
        roots.append(d.parent)
    best: dict | None = None
    seen: set[str] = set()
    for r in roots:
        key = str(r).lower()
        if key in seen:
            continue
        seen.add(key)
        info = _parse_game_log(r / "crash_dump" / "stdout.txt")
        if info and (best is None or info["log_mtime"] > best["log_mtime"]):
            best = info
    if best is not None:
        best = dict(best)
        best["log_age_s"] = max(0.0, time.time() - best["log_mtime"])
        ud = best["userdata"]
        if ud and d is not None:
            best["userdata_matches"] = _same_path(Path(ud), d.parent)
        else:
            best["userdata_matches"] = None
    return best


def _same_path(a: Path, b: Path) -> bool:
    def norm(p: Path) -> str:
        try:
            p = p.resolve()
        except OSError:
            pass
        return str(p).replace("/", "\\").rstrip("\\").lower()
    return norm(a) == norm(b)


def game_log_lines(info: dict | None, watched_dir: Path | None) -> list[tuple[str, str]]:
    """Human summary of game_log() for the collector console: (level, text) pairs, levels as in console.py."""
    if not info:
        return []
    out = [("info", f"game log: {info['log']} ({int(info['log_age_s'] // 60)} min old)")]
    if info["userdata"]:
        if info["userdata_matches"] is False and watched_dir is not None:
            out.append(("error", f"the game uses userdata folder {info['userdata']} but the companion watches "
                        f"{watched_dir}: create {CONFIG.name} with the game's folder + \\{EXPORT_SUBDIR}, or check "
                        f"which Steam account launches the game"))
        else:
            out.append(("info", f"game userdata folder: {info['userdata']}"))
    if not info["mod_loaded"]:
        out.append(("warn", "the mod 'Second Screen Dashboard' is NOT in the game's mod list (subscribe in the Mod Hub)"))
    else:
        summary = (f"mod loaded from {info['mod_source'] or '?'}; {info['written']} snapshot(s) written, "
                   f"{info['save_errors']} write error(s)")
        if info["save_errors"]:
            out.append(("error", summary + f": {info['last_error']}"))
            if info.get("writes_to") is None and (info.get("build") or 0) >= 40420 and \
                    "not available or invalid" in (info["last_error"] or ""):
                out.append(("error", f"game build {info['build']} only lets mods write to a few folders: this is the "
                            f"mod revision 8 or older trying to write to {LEGACY_SUBDIR}. Update the mod to revision 9 "
                            f"in the Mod Hub (or let it update), then reload the savegame"))
        elif info["mod_lines"] == 0:
            out.append(("warn", summary))
            out.append(("warn", "the mod never ran: enable it in the Mods menu of the savegame and load the map"))
        else:
            out.append(("ok", summary))
    return out


_SYNC_MARKERS = ("onedrive", "dropbox", "google drive", "googledrive", "iclouddrive", "icloud drive", "nextcloud",
                 "pcloud")  # matched as a prefix of a folder name ("OneDrive - Company", "Dropbox (Personal)")


def synced_dirs(*paths: str | os.PathLike | None) -> list[str]:
    """Among ROOT and the given paths, those that live in a cloud-synced folder (well-known folder names, OneDrive
    environment variables). SQLite and sync clients do not mix: locked files, conflict copies, files-on-demand
    placeholders -> empty or corrupt database."""
    roots = [os.environ.get(v) for v in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial")]
    roots = [str(Path(r)).lower().rstrip("\\") for r in roots if r]
    out: list[str] = []
    seen: set[str] = set()
    for p in (ROOT, *paths):
        if p is None:
            continue
        s = str(Path(p)).lower()
        if s in seen:
            continue
        seen.add(s)
        hit = any(part.startswith(m) for part in Path(s).parts for m in _SYNC_MARKERS) or \
            any(s.startswith(r + "\\") or s == r for r in roots)
        if hit:
            out.append(str(p))
    return out


def sync_warning(*paths: str | os.PathLike | None) -> list[str]:
    """Console text for synced_dirs()."""
    return [f"{'the companion' if Path(p) == ROOT else 'the database'} is in a cloud-synced folder ({p}). SQLite "
            f"databases and OneDrive/Dropbox do not mix (locked files, conflict copies, empty database): move "
            f"TF3-Dashboard to e.g. C:\\TF3-Dashboard" for p in synced_dirs(*paths)]


def not_found_hint() -> str:
    appdata = os.environ.get("APPDATA", r"C:\Users\<you>\AppData\Roaming").replace("\\", "\\\\")
    return (
        "Could not find the Transport Fever 3 userdata folder (neither Steam nor Epic/GOG).\n"
        "  - Start the game once with the 'Second Screen Dashboard' mod enabled in your savegame, or\n"
        f"  - create {CONFIG.name} next to run_dashboard.cmd with the folder of your installation:\n"
        '      Steam:    { "export_dir": "C:\\\\Program Files (x86)\\\\Steam\\\\userdata\\\\<id>\\\\3493540\\\\local\\\\towns_industries" }\n'
        f'      Epic/GOG: {{ "export_dir": "{appdata}\\\\Transport Fever 3\\\\towns_industries" }}'
    )


def _is_reparse_point(p: Path) -> bool:
    """Junction, symlink or other reparse point (Windows attribute 0x400; symlink elsewhere). A Steam folder moved
    with a junction (C:\\Steam -> another drive) is a known way for the game's own writes to fail."""
    try:
        st = p.lstat()
    except OSError:
        return False
    attrs = getattr(st, "st_file_attributes", 0)
    return bool(attrs & 0x400) or p.is_symlink()


def diag(explicit: str | os.PathLike | None = None, db: str | os.PathLike | None = None) -> dict:
    """What the dashboard needs to explain an empty database: where the game's export is looked for and what was
    found there, plus what the game's own log says. Cheap (a few stat calls; the log is re-read only when it
    changed), safe to call on every poll."""
    d = export_dir(explicit)
    source = "explicit" if explicit else "config" if load_config().get("export_dir") else \
        "env" if os.environ.get("TF3_EXPORT_DIR") else "auto"
    stores = {str(r / EXPORT_SUBDIR).lower(): s for s, r in userdata_roots()}
    out: dict = {
        "export_dir": str(d) if d else None,
        "source": source,
        "store": stores.get(str(d).lower()) if d else None,
        "dir_exists": bool(d and d.is_dir()),
        "live_exists": False,
        "live_age_s": None,
        "live_size": None,
        "candidates": [{"store": s, "dir": str(r / EXPORT_SUBDIR), "exists": (r / EXPORT_SUBDIR).is_dir()}
                       for s, r in userdata_roots()],
        "config_present": CONFIG.exists(),
    }
    if d:
        out["live_name"] = live_name(d)
        out["legacy_layout"] = prefix_for(d) == LEGACY_PREFIX
        try:
            st = (d / live_name(d)).stat()
            out.update(live_exists=True, live_age_s=max(0.0, time.time() - st.st_mtime), live_size=st.st_size)
        except OSError:
            pass
        # Files the companion itself writes there (activity, cmd): when they exist but the game reports write errors,
        # the folder is fine for a normal process and only the game process is refused (Controlled folder access /
        # antivirus, the game under another token, or - build 40420 - a folder the game no longer allows).
        out["companion_files"] = [n for n in ("activity", "cmd") if file_in(d, n).is_file()]
        out["reparse_point"] = _is_reparse_point(d) or any(_is_reparse_point(p) for p in d.parents if len(p.parts) > 1)
    out["game_log"] = game_log(explicit)
    out["synced_dirs"] = synced_dirs(db)
    return out


if __name__ == "__main__":
    print("config:", CONFIG, "(present)" if CONFIG.exists() else "(absent)")
    print("steam roots:", *[str(r) for r in steam_roots()] or ["-"], sep="\n  ")
    print("userdata roots:", *[f"{s}: {r}" for s, r in userdata_roots()] or ["-"], sep="\n  ")
    print("candidates:", *[str(c) for c in candidate_export_dirs()] or ["-"], sep="\n  ")
    print("export_dir:", export_dir())
    print("db:", db_path())
    print("port:", port())
    print("diag:", json.dumps(diag(), indent=1))
