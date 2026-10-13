"""Count the chunk-level locals of the mod script. Lua caps a function at 200 locals, the main chunk included, and the
game refused to load revision 18 at 194 by this count (the game's Lua keeps a few for itself). Fails above LIMIT so a
release is never built with a script the game cannot compile.

Counts "local a, b = ..." and "local function f" at indentation zero, outside long comments and long strings, with
their actual variable count. Comments and strings are stripped the cheap way: good enough for this one file, which has
no "local" inside a long string."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "mod" / "tf3_dashboard_export" / "content" / "dashboard_export" / "dashboard_export.script.lua"
LIMIT = 185

LONG = re.compile(r"--\[(=*)\[.*?\]\1\]|\[(=*)\[.*?\]\2\]", re.S)
LINE_COMMENT = re.compile(r"--[^\n]*")


def count(text: str) -> int:
    text = LONG.sub("", text)
    text = LINE_COMMENT.sub("", text)
    n = 0
    for line in text.split("\n"):
        if line.startswith("local function "):
            n += 1
        elif line.startswith("local "):
            names = line[6:].split("=", 1)[0]
            n += len([x for x in names.split(",") if x.strip()])
    return n


def main() -> int:
    n = count(SCRIPT.read_text(encoding="utf-8"))
    print(f"[lua] chunk-level locals: {n} (limit {LIMIT}, Lua hard limit 200)")
    return 0 if n <= LIMIT else 1


if __name__ == "__main__":
    sys.exit(main())
