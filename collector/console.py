"""Coloured, levelled console output shared by the collector and the server.

Levels: title (cyan), ok (green), info (default), wait (yellow), warn (bold yellow, "!"), error (bold red, "!!").
Colours only when stdout is a terminal and NO_COLOR is not set, so a redirected log file stays plain text.
On Windows the console needs virtual-terminal processing switched on once (Windows Terminal does it itself,
the classic conhost does not); failing that we fall back to plain text. Stdlib only.
"""
from __future__ import annotations

import os
import sys
import time

_CODES = {
    "title": "\x1b[1;36m", "ok": "\x1b[32m", "info": "", "wait": "\x1b[33m",
    "warn": "\x1b[1;33m", "error": "\x1b[1;31m", "dim": "\x1b[90m", "reset": "\x1b[0m",
}
_PREFIX = {"warn": "! ", "error": "!! "}
_enabled: bool | None = None


def _enable_windows_vt() -> bool:
    if sys.platform != "win32":
        return True
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
        mode = ctypes.c_uint32()
        if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            return False
        if mode.value & 0x0004:  # ENABLE_VIRTUAL_TERMINAL_PROCESSING already on (Windows Terminal)
            return True
        return bool(kernel32.SetConsoleMode(handle, mode.value | 0x0004))
    except Exception:
        return False


def enabled() -> bool:
    global _enabled
    if _enabled is None:
        try:
            tty = sys.stdout.isatty()
        except Exception:
            tty = False
        _enabled = bool(tty) and not os.environ.get("NO_COLOR") and _enable_windows_vt()
    return _enabled


def paint(text: str, level: str) -> str:
    code = _CODES.get(level, "")
    return f"{code}{text}{_CODES['reset']}" if code and enabled() else text


def say(msg: str, level: str = "info", *, stamp: bool = True) -> None:
    """Print one message; extra lines of a multi-line message are indented under the first."""
    lines = str(msg).split("\n")
    ts = time.strftime("%H:%M:%S") if stamp else ""
    head = paint(ts, "dim") + " " if ts else ""
    pad = " " * (len(ts) + 1) if ts else ""
    prefix = _PREFIX.get(level, "")
    out = [head + paint(prefix + lines[0], level)]
    out += [pad + paint("   " + ln, level) for ln in lines[1:]]
    print("\n".join(out), flush=True)


def banner(title: str, *details: str) -> None:
    """Start-up header: bold title, then one dim-labelled line per detail."""
    say(title, "title", stamp=False)
    for d in details:
        say("  " + d, "info", stamp=False)
