"""Locate the Transport Fever 3 userdata folder where the mod writes live.lua (and reads cmd.lua).

Resolution order:
  1. ROOT/config.json  -> {"export_dir": "...", "port": 8765}   (written by the user, optional)
  2. environment TF3_EXPORT_DIR
  3. Steam: <SteamPath>/userdata/<any id>/3493540/local/dashboard_export   (registry, then default folders)
  4. Epic / GOG / Microsoft Store: %LOCALAPPDATA%/Transport Fever 3/...  (best effort, scanned for dashboard_export)
When several candidates exist, the one whose live.lua was modified most recently wins.
Stdlib only.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent      # the TF3 Dashboard folder
CONFIG = ROOT / "config.json"
APP_ID = "3493540"
EXPORT_SUBDIR = "dashboard_export"
DEFAULT_DB = ROOT / "db" / "tf3_dashboard.db"
DEFAULT_PORT = 8765


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


def candidate_export_dirs() -> list[Path]:
    """All dashboard_export folders that exist (or could exist) on this machine, most recent first."""
    cands: list[Path] = []
    for root in steam_roots():
        ud = root / "userdata"
        if ud.is_dir():
            for acct in ud.iterdir():
                local = acct / APP_ID / "local"
                if local.is_dir():
                    cands.append(local / EXPORT_SUBDIR)
    # non-Steam stores keep userdata under the user profile; scan one level for a dashboard_export folder
    for env in ("LOCALAPPDATA", "APPDATA"):
        base = os.environ.get(env)
        if not base:
            continue
        for name in ("Transport Fever 3", "TransportFever3"):
            p = Path(base) / name
            if p.is_dir():
                for sub in [p] + [d for d in p.iterdir() if d.is_dir()]:
                    if (sub / EXPORT_SUBDIR).is_dir() or sub.name == "local":
                        cands.append(sub / EXPORT_SUBDIR)

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


def not_found_hint() -> str:
    return (
        "Could not find the Transport Fever 3 userdata folder.\n"
        "  - Start the game once with the 'Second Screen Dashboard' mod enabled in your save, or\n"
        f"  - create {CONFIG.name} next to run_dashboard.cmd with:\n"
        '    { "export_dir": "C:\\\\Program Files (x86)\\\\Steam\\\\userdata\\\\<id>\\\\3493540\\\\local\\\\dashboard_export" }'
    )


if __name__ == "__main__":
    print("config:", CONFIG, "(present)" if CONFIG.exists() else "(absent)")
    print("steam roots:", *[str(r) for r in steam_roots()] or ["-"], sep="\n  ")
    print("candidates:", *[str(c) for c in candidate_export_dirs()] or ["-"], sep="\n  ")
    print("export_dir:", export_dir())
    print("db:", db_path())
    print("port:", port())
