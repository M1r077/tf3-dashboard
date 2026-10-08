"""Builds the release archives into release/ (runs on Windows, Linux and macOS):

  TF3-Dashboard-<version>-windows.zip    companion + bundled Python (embeddable package, nothing to install),
                                         .cmd launchers with CRLF line endings
  TF3-Dashboard-<version>-linux.tar.gz   companion without Python (every distro ships 3.10+), .sh launchers with LF
                                         line endings and the executable bit (zip loses it with many unpackers)
  tf3_dashboard_export-rev<N>.zip        the mod, for manual installation outside mod.io

Usage: python build_release.py [--targets windows,linux,mod]
OR (on mac): python3 build_release.py [--targets windows,linux,mod]
The version is VERSION = "x.y.z" in dashboard/server.py (bump it there first), the mod revision is "revision" in
mod/tf3_dashboard_export/mod.json. The Python embeddable package is downloaded once into release/cache/.
Stdlib only.
"""
from __future__ import annotations

import argparse
import io
import json
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "collector"))
import tf3paths  # noqa: E402

PYVER = "3.12.10"
PYZIP = f"python-{PYVER}-embed-amd64.zip"
PYURL = f"https://www.python.org/ftp/python/{PYVER}/{PYZIP}"
OUT = ROOT / "release"
TOP = "TF3-Dashboard"                      # top folder inside both companion archives
MOD = ROOT / "mod" / "tf3_dashboard_export"

COMMON_ROOT_FILES = ["launch.py", "README.md", "LICENSE", "config.example.json",
                     "music/README.txt"]  # music/: the player's own tracks for the camera travelling
PLATFORM_FILES = {  # launchers per platform (repository path)
    "windows": ["run_dashboard.cmd", "_collector.cmd", "_server.cmd", "_python.cmd", "collector/run_collector.cmd"],
    "linux": ["run_dashboard.sh", "_python.sh", "collector/run_collector.sh"],
}
# never shipped: developer-only docs, the mod.io entry id (private to the author: the Mod Hub would try to *update*
# that entry instead of creating a new one), the icons extracted from the developer's own game
EXCLUDE_DOCS = {"LINUX_PLAN.md"}
EXCLUDE_MOD = {"_metadata/mod.io_fileid.txt"}


def _excluded_static(rel: str) -> bool:
    """No icons extracted from the developer's game (our own drawn icons in icons/own/ do ship), no probe files."""
    rel = f"/{rel}"
    return ("/icons/" in rel and not rel.startswith("/icons/own/")) or "_probe" in rel


def checks() -> bool:
    """Before any archive: translations complete, and old databases still migrate and ingest (0.6.1 shipped without
    that). Node.js is needed for the translation check, as in the Windows build."""
    print("[build] checks")
    for name, argv in (("i18n", ["node", str(ROOT / "test" / "i18ncheck.js")]),
                       ("migration", [sys.executable, str(ROOT / "test" / "migrate_check.py")])):
        try:
            rc = subprocess.run(argv, cwd=ROOT).returncode
        except OSError as e:
            rc = e
        if rc != 0:
            print(f"[build] {name} check failed ({rc}): no release", file=sys.stderr)
            return False
    return True


def companion_files(platform: str) -> list[tuple[Path, str]]:
    """(source, path inside the archive below TOP) for one platform."""
    files: list[tuple[Path, str]] = []

    def add(src: Path) -> None:
        files.append((src, src.relative_to(ROOT).as_posix()))

    for p in sorted((ROOT / "collector").glob("*.py")) + [ROOT / "collector" / "schema.sql"]:
        add(p)
    for p in sorted((ROOT / "dashboard").glob("*.py")):
        add(p)
    for p in sorted((ROOT / "dashboard" / "static").rglob("*")):
        rel = p.relative_to(ROOT / "dashboard" / "static").as_posix()
        if p.is_file() and not _excluded_static(rel):
            add(p)
    for p in sorted((ROOT / "docs").rglob("*")):
        if p.is_file() and p.name not in EXCLUDE_DOCS:
            add(p)
    for name in COMMON_ROOT_FILES + PLATFORM_FILES[platform]:
        add(ROOT / name)
    for p in sorted(MOD.rglob("*")):
        if p.is_file() and p.relative_to(MOD).as_posix() not in EXCLUDE_MOD:
            add(p)
    return files


def _content(src: Path) -> bytes:
    """File bytes; launchers get the line endings their shell needs whatever the working copy has (cmd.exe fails
    with "The system cannot find the batch label specified" on LF, sh fails on CRLF)."""
    data = src.read_bytes()
    if src.suffix in (".cmd", ".sh"):
        data = data.replace(b"\r\n", b"\n")
        if src.suffix == ".cmd":
            data = data.replace(b"\n", b"\r\n")
    return data


def _mode(arcname: str) -> int:
    return 0o755 if arcname.endswith(".sh") else 0o644


def python_embedded() -> Path:
    cached = OUT / "cache" / PYZIP
    if not cached.exists():
        print(f"[build] downloading {PYURL}")
        cached.parent.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_suffix(".part")
        with urllib.request.urlopen(PYURL, timeout=60) as r, open(tmp, "wb") as f:
            f.write(r.read())
        tmp.replace(cached)
    return cached


def _zip_write(z: zipfile.ZipFile, arcname: str, data: bytes, mtime: float, mode: int = 0o644) -> None:
    info = zipfile.ZipInfo(arcname, time.localtime(max(mtime, 315532800))[:6])  # zip dates start in 1980
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (0o100000 | mode) << 16
    z.writestr(info, data)


def build_windows(version: str) -> Path:
    dist = OUT / f"TF3-Dashboard-{version}-windows.zip"
    pyzip = python_embedded()
    with zipfile.ZipFile(dist, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        # the embeddable build ships python312.zip (stdlib) + python312._pth; nothing else is needed (no pip)
        with zipfile.ZipFile(pyzip) as py:
            for info in py.infolist():
                if not info.is_dir():
                    _zip_write(z, f"{TOP}/python_embedded/{info.filename}", py.read(info), time.mktime(info.date_time + (0, 0, -1)))
        for src, rel in companion_files("windows"):
            _zip_write(z, f"{TOP}/{rel}", _content(src), src.stat().st_mtime)
        z.writestr(f"{TOP}/db/", b"")
        _zip_write(z, f"{TOP}/VERSION", f"{version}\r\n".encode(), time.time())
    return dist


def build_linux(version: str) -> Path:
    dist = OUT / f"TF3-Dashboard-{version}-linux.tar.gz"

    def info(name: str, size: int, mtime: float, mode: int, kind=tarfile.REGTYPE) -> tarfile.TarInfo:
        ti = tarfile.TarInfo(name)
        ti.size, ti.mtime, ti.mode, ti.type = size, int(mtime), mode, kind
        ti.uname = ti.gname = ""
        return ti

    with tarfile.open(dist, "w:gz", format=tarfile.PAX_FORMAT) as t:
        t.addfile(info(TOP, 0, time.time(), 0o755, tarfile.DIRTYPE))
        for src, rel in companion_files("linux"):
            data = _content(src)
            t.addfile(info(f"{TOP}/{rel}", len(data), src.stat().st_mtime, _mode(rel)), io.BytesIO(data))
        t.addfile(info(f"{TOP}/db", 0, time.time(), 0o755, tarfile.DIRTYPE))
        data = f"{version}\n".encode()
        t.addfile(info(f"{TOP}/VERSION", len(data), time.time(), 0o644), io.BytesIO(data))
    return dist


def build_mod() -> Path:
    # utf-8-sig: mod.json starts with a UTF-8 byte order mark (EF BB BF), which json.loads refuses
    rev = json.loads((MOD / "mod.json").read_text(encoding="utf-8-sig"))["revision"]
    dist = OUT / f"tf3_dashboard_export-rev{rev}.zip"
    with zipfile.ZipFile(dist, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in sorted(MOD.rglob("*")):
            rel = p.relative_to(MOD).as_posix()
            if p.is_file() and rel not in EXCLUDE_MOD:
                _zip_write(z, f"{MOD.name}/{rel}", p.read_bytes(), p.stat().st_mtime)
    return dist


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--targets", default="windows,linux,mod", help="comma-separated subset of windows,linux,mod")
    ap.add_argument("--skip-checks", action="store_true",
                    help="build without the checks (migrate_check.py needs the old databases test/real.db, test/test.db)")
    a = ap.parse_args(argv)
    targets = {x.strip() for x in a.targets.split(",") if x.strip()}
    unknown = targets - {"windows", "linux", "mod"}
    if unknown:
        ap.error(f"unknown target(s): {', '.join(sorted(unknown))}")
    version = tf3paths.version()
    if version == "?":
        print("could not read VERSION from dashboard/server.py", file=sys.stderr)
        return 1
    print(f"[build] version {version}")
    if a.skip_checks:
        print("[build] checks skipped (--skip-checks): not for a published release")
    elif targets & {"windows", "linux"} and not checks():
        return 1
    OUT.mkdir(exist_ok=True)
    built = []
    if "windows" in targets:
        built.append(build_windows(version))
    if "linux" in targets:
        built.append(build_linux(version))
    if "mod" in targets:
        built.append(build_mod())
    print("[build] done:")
    for p in built:
        print(f"  {p.relative_to(ROOT)}  ({p.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
