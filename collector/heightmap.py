"""Full-resolution terrain heightmap: band files written by the mod -> one 16-bit grayscale PNG per game.

The mod reads the terrain tile by tile (TERRAIN_TILE_HEIGHTMAP: 65x65 integers at 4 m, metres = raw * res_z + offset_z)
and writes bands of tile rows as tf3dash_height_<k>.lua, each tile one string: the first value, then the difference
to the previous vertex, as variable-length base-64 digits (5 payload bits per digit, bit 32 = more digits follow,
zigzag sign). Here: decode every band, lay the tiles side by side (neighbouring tiles share their edge vertices, so a
tile contributes 64 columns/rows and the last one 65) and write db/height_<game_id>.png, a 16-bit grayscale PNG the
browser decodes natively. Standard library only (zlib, struct).

Pixel value = raw height (the 5 cm unit), so the dashboard converts with res_z / offset_z from the sidecar JSON.
"""
from __future__ import annotations

import json
import struct
import zlib
from pathlib import Path
from typing import Any

B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
IDX = {c: i for i, c in enumerate(B64)}


def decode_tile(s: str, n: int) -> list[int]:
    """Variable-length zigzag deltas -> n absolute raw heights."""
    out: list[int] = []
    i, prev = 0, None
    ln = len(s)
    while len(out) < n and i < ln:
        z, shift = 0, 0
        while True:
            d = IDX.get(s[i], 0)
            i += 1
            z |= (d & 31) << shift
            shift += 5
            if d < 32 or i >= ln:
                break
        v = (z >> 1) if (z & 1) == 0 else -((z + 1) >> 1)
        if prev is not None:
            v += prev
        out.append(v)
        prev = v
    if len(out) < n:
        out.extend([out[-1] if out else 0] * (n - len(out)))
    return out


class HeightAssembler:
    """Collects the bands of one export (identified by `revs`) and writes the PNG when all are in."""

    def __init__(self) -> None:
        self.revs: str | None = None
        self.bands: dict[int, dict] = {}
        self.meta: dict | None = None

    def add(self, band: dict) -> bool:
        """Feed one band file. Returns True when the map is complete (all bands of the same export present)."""
        revs = str(band.get("revs"))
        if revs != self.revs:
            self.revs, self.bands, self.meta = revs, {}, None
        k = int(band.get("band", -1))
        if k < 0:
            return False
        self.bands[k] = band
        self.meta = band
        total = int(band.get("bands") or 0)
        return total > 0 and all(i in self.bands for i in range(total))

    def write_png(self, path: Path) -> dict[str, Any]:
        """Assemble and write; returns the sidecar metadata (also written next to the PNG as .json)."""
        m = self.meta or {}
        nx, ny = int(m["grid"][0]), int(m["grid"][1])
        side = int(m.get("side") or 65)
        step = float(m.get("step") or 4)
        band_rows = int(m.get("band_rows") or 4)
        w, h = nx * (side - 1) + 1, ny * (side - 1) + 1
        rows: list[bytearray] = [bytearray(w * 2) for _ in range(h)]
        lo, hi = 1 << 30, -(1 << 30)
        for k in sorted(self.bands):
            band = self.bands[k]
            tiles = band.get("tiles") or []
            row0 = int(band.get("row0") or k * band_rows)
            for t, s in enumerate(tiles):
                if not isinstance(s, str):
                    continue
                col, row = t % nx, row0 + t // nx
                vals = decode_tile(s, side * side)
                # tile rows and vertex rows run south to north (tile ty0 = -n/2 is the southern edge, +Y north);
                # the PNG runs north (row 0) to south like the geography grid, so both are flipped here
                x0, y0 = col * (side - 1), (ny - 1 - row) * (side - 1)
                for r in range(side):
                    line = rows[y0 + (side - 1 - r)]
                    base = r * side
                    for c in range(side):
                        v = vals[base + c]
                        if v < 0:
                            v = 0
                        elif v > 65535:
                            v = 65535
                        if v < lo:
                            lo = v
                        if v > hi:
                            hi = v
                        p = (x0 + c) * 2
                        line[p] = v >> 8
                        line[p + 1] = v & 255
        raw = b"".join(b"\x00" + bytes(r) for r in rows)  # filter 0 per scanline

        def chunk(tag: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 16, 0, 0, 0, 0)) \
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")
        path.write_bytes(png)
        side_m = (side - 1) * step
        meta = {
            "width": w, "height": h, "step": step, "res_z": float(m.get("res_z") or 0.05), "offset_z": float(m.get("offset_z") or 0),
            "water_level": float(m.get("water_level") or 0), "grid": [nx, ny], "origin": m.get("origin"),
            # world extent: tile (origin) starts at origin * tile side metres from the map centre
            "bounds": [float(m["origin"][0]) * side_m, float(m["origin"][1]) * side_m,
                       (float(m["origin"][0]) + nx) * side_m, (float(m["origin"][1]) + ny) * side_m],
            "raw_min": lo, "raw_max": hi, "revs": self.revs, "bytes": len(png),
        }
        path.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
        return meta
