"""Locate the Transport Fever 3 userdata folder where the mod writes live.lua (and reads cmd.lua).

Resolution order:
  1. ROOT/config.json  -> {"export_dir": "...", "port": 8765}   (written by the user, optional)
  2. environment TF3_EXPORT_DIR
  3. Steam: <SteamPath>/userdata/<any id>/3493540/local/dashboard_export   (registry, then default folders)
  4. Epic / GOG (Windows): %APPDATA%/Transport Fever 3/dashboard_export  (the game keeps save/, settings.lua,
     profile.lua there when it is not the Steam build; %LOCALAPPDATA% is scanned too, best effort)
  5. macOS: ~/Library/Application Support/Transport Fever 3 ; Linux: ~/.local/share/Transport Fever 3
When several candidates exist, the one whose live.lua was modified most recently wins; a candidate whose
dashboard_export folder does not exist yet is kept (the game creates it at the first export).
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


def not_found_hint() -> str:
    appdata = os.environ.get("APPDATA", r"C:\Users\<you>\AppData\Roaming").replace("\\", "\\\\")
    return (
        "Could not find the Transport Fever 3 userdata folder (neither Steam nor Epic/GOG).\n"
        "  - Start the game once with the 'Second Screen Dashboard' mod enabled in your savegame, or\n"
        f"  - create {CONFIG.name} next to run_dashboard.cmd with the folder of your installation:\n"
        '      Steam:    { "export_dir": "C:\\\\Program Files (x86)\\\\Steam\\\\userdata\\\\<id>\\\\3493540\\\\local\\\\dashboard_export" }\n'
        f'      Epic/GOG: {{ "export_dir": "{appdata}\\\\Transport Fever 3\\\\dashboard_export" }}'
    )


def diag(explicit: str | os.PathLike | None = None) -> dict:
    """What the dashboard needs to explain an empty database: where the game's export is looked for and what was
    found there. Cheap (a few stat calls), safe to call on every poll."""
    import time
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
