"""The few icons the dashboard draws itself: the camera movements of a travelling (orbit, dolly, flyover, sweep,
spiral) and "reverse the movement". The game has no icon for these, and borrowing one of its icons for another
meaning would mislead the player; everything else in the dashboard uses the game's own icons (extract_icons.py).

White strokes on transparent, 48x48 like the game's @2x icons, drawn with PIL at 4x then downsampled, so they sit
next to the extracted ones at the same weight. Output: dashboard/static/icons/own/<name>.png (committed: these are
ours, not the game's).

Usage: python own_icons.py
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

S = 48          # output size
K = 4           # supersampling
W = 3.2 * K     # stroke width (the game's thin icons are ~3 px at 48)
OUT = Path(__file__).parent / "static" / "icons" / "own"


def canvas():
    im = Image.new("RGBA", (S * K, S * K), (0, 0, 0, 0))
    return im, ImageDraw.Draw(im)


def save(im: Image.Image, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    im.resize((S, S), Image.LANCZOS).save(OUT / f"{name}.png")


def arrow_head(d: ImageDraw.ImageDraw, tip, angle, size=7 * K):
    """Filled triangle pointing along `angle` (radians) with its tip at `tip`."""
    a1, a2 = angle + math.radians(150), angle - math.radians(150)
    p1 = (tip[0] + size * math.cos(a1), tip[1] + size * math.sin(a1))
    p2 = (tip[0] + size * math.cos(a2), tip[1] + size * math.sin(a2))
    d.polygon([tip, p1, p2], fill="white")


def dot(d, c, r=3.2 * K):
    d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill="white")


def cam(d, c, w=11 * K, h=8 * K):
    """A small camera body + lens, the subject's marker in the movement icons."""
    x, y = c
    d.rounded_rectangle([x - w / 2, y - h / 2, x + w / 2 - 3 * K, y + h / 2], radius=1.5 * K, fill="white")
    d.polygon([(x + w / 2 - 3 * K, y - 1 * K), (x + w / 2, y - h / 2 + 1 * K), (x + w / 2, y + h / 2 - 1 * K), (x + w / 2 - 3 * K, y + 1 * K)], fill="white")


def orbit():
    # a ring around a big point, almost a full circle, arrow head where it closes (a satellite's orbit)
    im, d = canvas(); c = (24 * K, 24 * K); r = 19 * K
    d.arc([c[0] - r, c[1] - r, c[0] + r, c[1] + r], start=300, end=250, fill="white", width=int(W))
    tip = (c[0] + r * math.cos(math.radians(250)), c[1] + r * math.sin(math.radians(250)))
    arrow_head(d, tip, math.radians(250 - 90))
    dot(d, c, 6 * K)
    save(im, "move_orbit")


def dolly():
    # straight approach: a point, and an arrow coming from far along the view axis, with a smaller far marker
    im, d = canvas()
    dot(d, (24 * K, 36 * K), 3.6 * K)
    d.line([(24 * K, 8 * K), (24 * K, 26 * K)], fill="white", width=int(W))
    arrow_head(d, (24 * K, 29 * K), math.radians(90))
    d.line([(14 * K, 8 * K), (34 * K, 8 * K)], fill="white", width=int(W * 0.8))
    save(im, "move_dolly")


def flyover():
    # arrive from high and far, levelling out: a descending curve that flattens, arrow at the end
    im, d = canvas()
    pts = [(6 * K + t * 32 * K, 8 * K + (1 - (1 - t) ** 2) * 26 * K) for t in [i / 24 for i in range(25)]]
    d.line(pts, fill="white", width=int(W), joint="curve")
    arrow_head(d, (42 * K, 35 * K), math.radians(15))
    save(im, "move_flyover")


def sweep():
    # back and forth around the heading: a wide arc with arrow heads at both ends, pivoting on a point below
    im, d = canvas(); c = (24 * K, 42 * K); r = 24 * K
    d.arc([c[0] - r, c[1] - r, c[0] + r, c[1] + r], start=220, end=320, fill="white", width=int(W))
    arrow_head(d, (c[0] + r * math.cos(math.radians(320)), c[1] + r * math.sin(math.radians(320))), math.radians(50))
    arrow_head(d, (c[0] + r * math.cos(math.radians(220)), c[1] + r * math.sin(math.radians(220))), math.radians(130))
    dot(d, (c[0], c[1] - 6 * K), 3.5 * K)
    save(im, "move_sweep")


def spiral():
    # a spiral closing in on the centre, arrow at the inner end
    im, d = canvas(); c = (24 * K, 25 * K)
    pts = []
    for i in range(0, 361 * 2, 6):
        a = math.radians(i); r = 20 * K * (1 - i / (361 * 2) * 0.72)
        pts.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a) * 0.85))
    d.line(pts, fill="white", width=int(W), joint="curve")
    x0, y0 = pts[-2]; x1, y1 = pts[-1]
    arrow_head(d, pts[-1], math.atan2(y1 - y0, x1 - x0), size=6 * K)
    dot(d, c, 2.4 * K)
    save(im, "move_spiral")


def reverse():
    # the movement played backwards: a play triangle pointing left with a bar, like "rewind" but a single one
    im, d = canvas()
    d.polygon([(34 * K, 10 * K), (34 * K, 38 * K), (14 * K, 24 * K)], fill="white")
    d.rectangle([9 * K, 10 * K, 12.5 * K, 38 * K], fill="white")
    save(im, "move_reverse")


if __name__ == "__main__":
    for f in (orbit, dolly, flyover, sweep, spiral, reverse):
        f()
    print(f"6 icons -> {OUT}")
