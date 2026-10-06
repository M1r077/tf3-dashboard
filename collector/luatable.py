"""Minimal parser for Lua table literals as written by Transport Fever's app.saveUserdata.

Handles: nested tables, string keys (`name = ` and `["name"] = `), numeric keys (`[3] = `),
positional entries, numbers (incl. 1e+06, -inf, nan), strings with escapes, booleans, nil,
comments (`--`), and an optional leading `return` or `function data() return ... end`.
Lua arrays (keys 1..n without gaps) become Python lists; everything else becomes dicts.
No dependency on external libraries.
"""
from __future__ import annotations

import math
import re
from typing import Any

_TOKEN = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<comment>--\[(?P<eq>=*)\[.*?\](?P=eq)\]|--[^\n]*)
  | (?P<number>[-+]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?))
  | (?P<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')
  | (?P<longstring>\[(?P<eq2>=*)\[.*?\](?P=eq2)\])
  | (?P<name>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<punct>==|[{}\[\]=,;()])
    """,
    re.VERBOSE | re.DOTALL,
)

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'", "a": "\a", "b": "\b", "f": "\f", "v": "\v", "\n": "\n"}


class LuaParseError(ValueError):
    pass


def _unescape(s: str) -> str:
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            if n in _ESCAPES:
                out.append(_ESCAPES[n])
                i += 2
                continue
            if n.isdigit():
                j = i + 1
                while j < len(s) and j < i + 4 and s[j].isdigit():
                    j += 1
                out.append(chr(int(s[i + 1:j])))
                i = j
                continue
            if n == "x":
                out.append(chr(int(s[i + 2:i + 4], 16)))
                i += 4
                continue
        out.append(c)
        i += 1
    return "".join(out)


def _tokens(text: str):
    pos = 0
    n = len(text)
    while pos < n:
        m = _TOKEN.match(text, pos)
        if not m:
            raise LuaParseError(f"unexpected character {text[pos]!r} at {pos}")
        pos = m.end()
        kind = m.lastgroup
        if kind in ("ws", "comment"):
            continue
        if kind == "eq" or kind == "eq2":
            continue
        yield kind, m.group(kind), m.start()
    yield "eof", "", n


class _Parser:
    """Recursive-descent parser over a pre-tokenised list (no generator stacking, no recursion in lookahead)."""

    def __init__(self, text: str):
        self._toks = list(_tokens(text))
        self._i = 0

    @property
    def _tok(self):
        return self._toks[self._i]

    def _advance(self):
        if self._i < len(self._toks) - 1:
            self._i += 1

    def _peek(self, k: int = 1):
        j = min(self._i + k, len(self._toks) - 1)
        return self._toks[j]

    def _expect(self, value: str):
        if self._tok[1] != value:
            raise LuaParseError(f"expected {value!r} got {self._tok[1]!r} at {self._tok[2]}")
        self._advance()

    def parse_document(self) -> Any:
        kind, val, _ = self._tok
        if kind == "name" and val == "function":
            # function data() return { ... } end
            while not (self._tok[0] == "name" and self._tok[1] == "return") and self._tok[0] != "eof":
                self._advance()
        if self._tok[0] == "name" and self._tok[1] == "return":
            self._advance()
        value = self.parse_value()
        # tolerate trailing 'end'
        if self._tok[0] == "name" and self._tok[1] == "end":
            self._advance()
        if self._tok[0] != "eof":
            raise LuaParseError(f"trailing data at {self._tok[2]}: {self._tok[1]!r}")
        return value

    def parse_value(self) -> Any:
        kind, val, pos = self._tok
        if kind == "punct" and val == "{":
            return self.parse_table()
        if kind == "number":
            self._advance()
            return _number(val)
        if kind == "string":
            self._advance()
            return _unescape(val[1:-1])
        if kind == "longstring":
            self._advance()
            inner = val[val.index("[", 1) + 1: val.rindex("]", 0, len(val) - 1)]
            return inner
        if kind == "name":
            self._advance()
            if val == "true":
                return True
            if val == "false":
                return False
            if val == "nil":
                return None
            if val in ("inf", "math", "huge"):
                return math.inf
            if val == "nan":
                return math.nan
            raise LuaParseError(f"unexpected identifier {val!r} at {pos}")
        if kind == "punct" and val in ("-", "+"):
            self._advance()
            v = self.parse_value()
            return -v if val == "-" else v
        raise LuaParseError(f"unexpected token {val!r} at {pos}")

    def parse_table(self) -> Any:
        self._expect("{")
        items: dict[Any, Any] = {}
        next_index = 1
        while True:
            kind, val, pos = self._tok
            if kind == "eof":
                raise LuaParseError("unexpected end of input inside table")
            if kind == "punct" and val == "}":
                self._advance()
                break
            key: Any
            if kind == "punct" and val == "[":
                self._advance()
                key = self.parse_value()
                self._expect("]")
                self._expect("=")
                value = self.parse_value()
            elif kind == "name" and self._peek()[0] == "punct" and self._peek()[1] == "=":
                key = val
                self._advance()
                self._expect("=")
                value = self.parse_value()
            else:
                key = next_index
                next_index += 1
                value = self.parse_value()
            if isinstance(key, float) and key.is_integer():
                key = int(key)
            items[key] = value
            kind, val, _ = self._tok
            if kind == "punct" and val in (",", ";"):
                self._advance()
        return _to_python(items)

def _number(s: str) -> float | int:
    t = s.lower()
    if t.startswith(("0x", "-0x", "+0x")):
        return int(s, 16)
    if re.fullmatch(r"[-+]?\d+", s):
        return int(s)
    return float(s)


    # 'math' '.' 'huge' : our tokenizer has no '.', so this path is rarely hit
    return math.inf


def _to_python(items: dict[Any, Any]) -> Any:
    if not items:
        return []
    keys = list(items.keys())
    if all(isinstance(k, int) for k in keys):
        ks = sorted(keys)
        if ks[0] == 1 and ks[-1] == len(ks):
            return [items[k] for k in ks]
    return items


def loads(text: str) -> Any:
    """Parse a Lua table literal (optionally prefixed by `return`) into Python data."""
    if text.startswith("\ufeff"):
        text = text[1:]
    return _Parser(text).parse_document()


def load(path: str, encoding: str = "utf-8") -> Any:
    with open(path, "r", encoding=encoding, errors="replace") as f:
        return loads(f.read())


if __name__ == "__main__":  # quick self-test
    sample = """
    -- generated
    return {
        schema = 1, name = "a\\"b", ok = true, none = nil, list = { 1, 2.5, -3, 1e+06 },
        ["with space"] = { x = 0.5, y = -0.25, },
        nested = { { id = 1, }, { id = 2, tags = { "a", "b" } } },
        empty = {},
    }
    """
    import json
    print(json.dumps(loads(sample), indent=1))
