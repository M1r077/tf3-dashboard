"""Locate the Transport Fever 3 userdata folder where the mod writes live.lua (and reads cmd.lua).

Resolution order:
  1. ROOT/config.json  -> {"export_dir": "...", "port": 8765}   (written by the user, optional)
  2. environment TF3_EXPORT_DIR
  3. Steam: <SteamPath>/userdata/<any id>/3493540/local/dashboard_export   (registry, then default folders)
  4. Epic / GOG (Windows): %APPDATA%/Transport Fever 3/dashboard_export  (the game keeps save/, settings.lua,
     profile.lua there when it is not the Steam build; %LOCALAPPDATA% is scanned too, best effort)
  5. macOS: ~/Library/Application Support/Transport Fever 3 ; Linux: ~/.local/share/Transport Fever 3
When several candidates exist, the one whose live.lua was modified most recently wins; a candidate whose
dashboard_export folder does not exist yet is kept (ensure_export_dir creates it: the game does not always).
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
EXPORT_SUBDIR = "dashboard_export"
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
    exist are returned (the game creates its userdata folder at the first start), the dashboard_export subfolder
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
                        if d.is_dir() and (d.name == "local" or (d / EXPORT_SUBDIR).is_dir()):
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
    """All dashboard_export folders that exist (or could exist) on this machine, most recent first."""
    cands = [root / EXPORT_SUBDIR for _, root in userdata_roots()]

    def mtime(d: Path) -> float:
        try:
            return (d / "live.lua").stat().st_mtime
        except OSError:
            return -1.0

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
    """Path of live.lua. `explicit` may be the file itself or its folder."""
    if explicit and str(explicit).lower().endswith(".lua"):
        return Path(explicit)
    d = export_dir(explicit)
    return d / "live.lua" if d else None


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
    """Create the dashboard_export folder wherever the game may look for it. app.saveUserdata does not create the
    folder itself on every installation ("The directory you trying to access is not available or invalid" in
    stdout.txt, reported by a Steam user), so the companion does: one empty folder per existing userdata root (and the
    configured/explicit folder when its parent exists). Returns the folders that were created now."""
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
    info: dict = {"log": str(log), "log_mtime": st.st_mtime, "userdata": None, "mod_loaded": False,
                  "mod_source": None, "mod_lines": 0, "written": 0, "save_errors": 0, "last_error": None,
                  "last_mod_line": None}
    for line in text.splitlines():
        if info["userdata"] is None and "User data folder:" in line:
            info["userdata"] = line.split("User data folder:", 1)[1].strip()
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
        '      Steam:    { "export_dir": "C:\\\\Program Files (x86)\\\\Steam\\\\userdata\\\\<id>\\\\3493540\\\\local\\\\dashboard_export" }\n'
        f'      Epic/GOG: {{ "export_dir": "{appdata}\\\\Transport Fever 3\\\\dashboard_export" }}'
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
        try:
            st = (d / "live.lua").stat()
            out.update(live_exists=True, live_age_s=max(0.0, time.time() - st.st_mtime), live_size=st.st_size)
        except OSError:
            pass
        # Files the companion itself writes there (activity.lua, cmd.lua): when they exist but the game reports
        # write errors, the folder is fine for a normal process and only the game process is refused (two users
        # so far: Controlled folder access / antivirus, or the game running under another token).
        out["companion_files"] = [f for f in ("activity.lua", "cmd.lua") if (d / f).is_file()]
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
