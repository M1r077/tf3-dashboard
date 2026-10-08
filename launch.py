"""TF3 Dashboard launcher, shared by Windows and Linux: starts the collector (live file -> SQLite) and the web server,
restarts them when they stop, opens the browser once the dashboard answers. Ctrl+C (or closing the terminal)
stops everything.

  launch.py                      collector + server in this terminal, lines prefixed [collector] / [server]
  launch.py --only collector     one of them, output as is (run_dashboard.cmd: one Windows Terminal pane each)
  launch.py --only server
  launch.py --install-desktop    Linux: add "TF3 Dashboard" to the application menu

--db is passed to both, --port / --no-cmd to the server. Before the first server start: the game's icons are
extracted when dashboard/static/icons/_manifest.json is missing or older than extract_icons.py (a new version that
uses more of the game's icons), and the port must be free (an old instance would otherwise keep serving old code).
Stdlib only.
"""
from __future__ import annotations

import argparse
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "collector"))
import console  # noqa: E402
import tf3paths  # noqa: E402

ICON_MANIFEST = ROOT / "dashboard" / "static" / "icons" / "_manifest.json"
ICON_EXTRACTOR = ROOT / "dashboard" / "extract_icons.py"
BACKOFF_S = (2, 5, 10, 30)   # delay before restart number 1, 2, 3, 4+ in a row
HEALTHY_S = 60               # a child that ran this long counts as healthy again (back to the first delay)
_print_lock = threading.Lock()


def icons_outdated() -> bool:
    """First start, or the icon list in extract_icons.py changed since the last extraction."""
    try:
        return ICON_EXTRACTOR.stat().st_mtime > ICON_MANIFEST.stat().st_mtime
    except OSError:
        return True


def port_answers(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def _child_env() -> dict:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONDONTWRITEBYTECODE="1")
    if console.enabled():
        env["TF3_COLOR"] = "1"
    return env


def _die_with_parent_hook():
    """Linux: children get SIGTERM when the launcher dies, even from SIGKILL (no orphaned server keeping the port).
    libc is resolved here, in the parent: the hook runs between fork and exec and must not import anything."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes
        prctl = ctypes.CDLL(None, use_errno=True).prctl
    except (OSError, AttributeError):
        return None
    return lambda: prctl(1, signal.SIGTERM)  # PR_SET_PDEATHSIG


class Child:
    def __init__(self, name: str, argv: list[str], prefixed: bool):
        self.name = name
        self.argv = argv
        self.prefixed = prefixed
        self.proc: subprocess.Popen | None = None
        self.started = 0.0
        self.failures = 0
        self.next_start = 0.0

    def ready(self) -> bool:
        """Checks before (re)starting; False = try again on a later tick."""
        return True

    def start(self, preexec) -> None:
        kw: dict = {"cwd": ROOT, "env": _child_env()}
        if preexec:
            kw["preexec_fn"] = preexec
        if self.prefixed:
            kw.update(stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.proc = subprocess.Popen([sys.executable, *self.argv], **kw)
        self.started = time.monotonic()
        if self.prefixed:
            threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()

    def _pump(self, proc: subprocess.Popen) -> None:
        tag = console.paint(f"[{self.name}]", "dim") + " " * (10 - len(self.name))
        for raw in proc.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            with _print_lock:
                print(f"{tag}{line}", flush=True)

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None


class Server(Child):
    def __init__(self, argv: list[str], prefixed: bool, port: int):
        super().__init__("server", argv, prefixed)
        self.port = port
        self.icons_done = False
        self.port_warned = False

    def ready(self) -> bool:
        if not self.icons_done:
            self.icons_done = True
            if icons_outdated():
                say("extracting the game's icons from the local installation, 20-40 seconds, the browser waits "
                    "meanwhile...", "info")
                subprocess.run([sys.executable, str(ICON_EXTRACTOR)], cwd=ROOT, env=_child_env())
                say("icons done.", "info")
        if port_answers(self.port):
            if not self.port_warned:
                say(f"port {self.port} is already in use (another TF3 Dashboard still running?). Close it; the server "
                    f"starts as soon as the port is free.", "warn")
                self.port_warned = True
            self.next_start = time.monotonic() + 2
            return False
        self.port_warned = False
        return True


def say(msg: str, level: str = "info") -> None:
    with _print_lock:
        console.say(msg, level)


def supervise(children: list[Child], url: str | None, server: Server | None) -> int:
    def on_signal(signum, frame):
        raise KeyboardInterrupt
    for name in ("SIGTERM", "SIGHUP", "SIGBREAK"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), on_signal)
    preexec = _die_with_parent_hook()
    opened = url is None
    try:
        while True:
            now = time.monotonic()
            for c in children:
                if c.proc is None:
                    if now >= c.next_start and c.ready():
                        c.start(preexec)
                    continue
                rc = c.proc.poll()
                if rc is None:
                    continue
                c.failures = 1 if now - c.started > HEALTHY_S else c.failures + 1
                delay = BACKOFF_S[min(c.failures, len(BACKOFF_S)) - 1]
                say(f"{c.name} stopped (exit code {rc}), restarting in {delay} s", "warn")
                c.proc = None
                c.next_start = now + delay
            if not opened and server is not None and server.running() and port_answers(server.port):
                webbrowser.open(url)
                opened = True
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop(children)
    return 0


def stop(children: list[Child]) -> None:
    """Ctrl+C reached the children too (same console / process group); terminate whatever is left."""
    try:
        for c in children:
            if c.running():
                c.proc.terminate()
        deadline = time.monotonic() + 5
        for c in children:
            if c.proc is not None:
                try:
                    c.proc.wait(max(0.1, deadline - time.monotonic()))
                except subprocess.TimeoutExpired:
                    c.proc.kill()
    except KeyboardInterrupt:  # second Ctrl+C: no more waiting
        for c in children:
            if c.running():
                c.proc.kill()


def _desktop_quote(s: str) -> str:
    """Quote an argument for the Exec key of a .desktop file (Desktop Entry spec)."""
    return '"' + "".join("\\" + ch if ch in '"`$\\' else ch for ch in s) + '"'


def install_desktop() -> int:
    if sys.platform in ("win32", "darwin"):
        say("--install-desktop is for Linux desktops only", "error")
        return 1
    f = tf3paths._xdg("XDG_DATA_HOME", ".local/share") / "applications" / "tf3-dashboard.desktop"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text("[Desktop Entry]\n"
                 "Type=Application\n"
                 "Name=TF3 Dashboard\n"
                 "Comment=Second screen dashboard for Transport Fever 3\n"
                 f"Exec={_desktop_quote(str(ROOT / 'run_dashboard.sh'))}\n"
                 f"Path={ROOT}\n"
                 "Terminal=true\n"
                 "Categories=Game;Utility;\n", encoding="utf-8")
    say(f"menu entry written: {f} (remove that file to undo)", "ok")
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=("collector", "server"), help="run only this part (output not prefixed)")
    ap.add_argument("--db", default=None, help="SQLite database (default: db/tf3_dashboard.db or config.json)")
    ap.add_argument("--port", type=int, default=None, help="HTTP port (default: 8765 or config.json)")
    ap.add_argument("--no-cmd", action="store_true", help="server: disable dashboard -> game commands")
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser")
    ap.add_argument("--install-desktop", action="store_true", help="Linux: add TF3 Dashboard to the application menu")
    a = ap.parse_args(argv)
    if a.install_desktop:
        return install_desktop()
    try:
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

    port = tf3paths.port(a.port)
    url = f"http://127.0.0.1:{port}/"
    db = ["--db", a.db] if a.db else []
    prefixed = a.only is None
    children: list[Child] = []
    server: Server | None = None
    if a.only in (None, "collector"):
        children.append(Child("collector", [str(ROOT / "collector" / "collector.py"), *db], prefixed))
    if a.only in (None, "server"):
        server = Server([str(ROOT / "dashboard" / "server.py"), "--port", str(port), *db,
                         *(["--no-cmd"] if a.no_cmd else [])], prefixed, port)
        children.append(server)

    title = "TF3 Dashboard" + {"collector": " Collector", "server": " Server"}.get(a.only or "", "")
    console.set_title(title)
    if prefixed:
        console.banner(f"TF3 Dashboard {tf3paths.version()}", f"dashboard: {url}", "Ctrl+C stops everything")
    return supervise(children, None if a.no_browser or server is None else url, server)


if __name__ == "__main__":
    sys.exit(main())
