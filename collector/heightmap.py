"""Full-resolution terrain heightmap: band files written by the mod -> one 16-bit grayscale PNG per game.

The mod reads the terrain tile by tile (TERRAIN_TILE_HEIGHTMAP: 65x65 integers at 4 m, metres = raw * res_z + offset_z)
and writes bands of tile rows as tf3dash_height_<k>.lua, each tile one string: the first value, then the difference
to the previous vertex, as variable-length base-64 digits (5 payload bits per digit, bit 32 = more digits follow,
zigzag sign). Here: decode every band as it arrives into one picture buffer (neighbouring tiles share their edge
vertices, so a tile contributes 64 columns/rows and the last one 65) and write db/height_<game_id>.png, a 16-bit
grayscale PNG the browser decodes natively. Standard library only (zlib, struct).

The picture is written while the bands are still coming (every few bands, fast compression) so that a new map's
relief appears on the dashboard band by band instead of all at once after a minute: the sidecar JSON says which
pixel rows are real (`rows_ready`) and the browser leaves the others transparent. The last write is the complete
picture at normal compression.

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
# two bands of one export are written within seconds of each other (the whole map in 20-30 s); files further apart
# than this belong to different exports. Generous: a loaded machine, a huge map
EXPORT_GAP_S = 120.0


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
    """Collects the bands of one export (identified by `revs`), decoding each into the picture as it comes."""

    def __init__(self) -> None:
        self.revs: str | None = None
        self.bands: dict[int, dict] = {}
        self.meta: dict | None = None
        self.rows: list[bytearray] = []
        self.ready: list[bool] = []          # per band index: decoded into self.rows
        self.lo, self.hi = 1 << 30, -(1 << 30)
        self.total = 0
        self.written_bands = -1              # how many bands the last PNG on disk had
        self.export_no = 0                   # bumped on every new export (new map or new terrain revisions)
        self.t_last = 0.0                    # file time of the newest band of the current export

    def _reset(self, revs: str, band: dict) -> None:
        self.revs, self.bands, self.meta = revs, {}, band
        self.export_no += 1
        self.t_last = float(band.get("_mtime") or 0)
        nx, ny = int(band["grid"][0]), int(band["grid"][1])
        side = int(band.get("side") or 65)
        w, h = nx * (side - 1) + 1, ny * (side - 1) + 1
        self.rows = [bytearray(w * 2) for _ in range(h)]
        self.total = int(band.get("bands") or 0)
        self.ready = [False] * max(self.total, 0)
        self.lo, self.hi = 1 << 30, -(1 << 30)
        self.written_bands = -1

    def add(self, band: dict) -> bool:
        """Feed one band file (decoded at once). Returns True when the map is complete (all bands present)."""
        revs = str(band.get("revs"))
        k = int(band.get("band", -1))
        # the mod's `revs` only counts the terrain tiles and their edit revisions: two untouched maps of the same size
        # share it. A band that was already received and comes back with other tiles is therefore a new export
        # (new map, or the terrain rebuilt): start over, else the old picture would silently stay
        same_shape = self.meta is not None and self.meta.get("grid") == band.get("grid") and self.meta.get("bands") == band.get("bands")
        # the file times tell the exports apart too: the mod writes its 22 bands within half a minute, so a band written
        # long after the one that started this export is the start of the next one (collector restarted mid-export: the
        # previous map's files of the same size come first in mtime order, then the fresh ones - without this the old
        # bands and the new were mixed and the fresh ones already read never came back)
        mt = float(band.get("_mtime") or 0)
        later = self.t_last > 0 and mt > self.t_last + EXPORT_GAP_S
        if revs != self.revs or not same_shape or later or (k in self.bands and self.bands[k].get("tiles") != band.get("tiles")):
            self._reset(revs, band)
        if self.t_last > 0 and mt and mt < self.t_last - EXPORT_GAP_S:  # leftover of an older export, the fresh one is under way
            return self.complete
        if mt:
            self.t_last = max(self.t_last, mt)
        if k < 0 or k >= self.total or k in self.bands:  # leftover files of a bigger map keep band numbers past the end
            return self.complete
        self.bands[k] = band
        self.meta = band
        self._decode(k, band)
        if 0 <= k < len(self.ready):
            self.ready[k] = True
        return self.complete

    @property
    def complete(self) -> bool:
        return self.total > 0 and all(i in self.bands for i in range(self.total))

    @property
    def n_done(self) -> int:
        return len(self.bands)

    def _decode(self, k: int, band: dict) -> None:
        m = self.meta or {}
        nx, ny = int(m["grid"][0]), int(m["grid"][1])
        side = int(m.get("side") or 65)
        band_rows = int(m.get("band_rows") or 4)
        rows = self.rows
        lo, hi = self.lo, self.hi
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
        self.lo, self.hi = lo, hi

    def rows_ready(self) -> list[list[int]]:
        """Pixel row ranges [y0, y1) that hold decoded terrain (north to south), merged."""
        m = self.meta or {}
        nx, ny = int(m["grid"][0]), int(m["grid"][1])
        side = int(m.get("side") or 65)
        band_rows = int(m.get("band_rows") or 4)
        out: list[list[int]] = []
        for k in sorted(self.bands):
            band = self.bands[k]
            row0 = int(band.get("row0") or k * band_rows)
            n_tiles = len(band.get("tiles") or [])
            n_rows = max(1, (n_tiles + nx - 1) // nx)
            # tile rows row0 .. row0+n_rows-1 (south to north) -> pixel rows, flipped
            y0 = (ny - row0 - n_rows) * (side - 1)
            y1 = (ny - row0) * (side - 1) + 1
            if out and out[-1][0] <= y1 and y0 <= out[-1][1]:
                out[-1] = [min(out[-1][0], y0), max(out[-1][1], y1)]
            else:
                out.append([y0, y1])
        return out

    def should_write(self, every: int = 3) -> bool:
        """A partial picture is worth writing every `every` bands, the complete one always."""
        return self.complete or (self.n_done - max(self.written_bands, 0)) >= every or self.written_bands < 0

    def write_png(self, path: Path) -> dict[str, Any]:
        """Write the picture as it stands; returns the sidecar metadata (also written next to the PNG as .json)."""
        m = self.meta or {}
        nx, ny = int(m["grid"][0]), int(m["grid"][1])
        side = int(m.get("side") or 65)
        step = float(m.get("step") or 4)
        w, h = nx * (side - 1) + 1, ny * (side - 1) + 1
        complete = self.complete
        raw = b"".join(b"\x00" + bytes(r) for r in self.rows)  # filter 0 per scanline

        def chunk(tag: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 16, 0, 0, 0, 0)) \
            + chunk(b"IDAT", zlib.compress(raw, 6 if complete else 1)) + chunk(b"IEND", b"")
        tmp = path.with_suffix(".png.tmp")
        tmp.write_bytes(png)
        tmp.replace(path)
        side_m = (side - 1) * step
        meta = {
            "width": w, "height": h, "step": step, "res_z": float(m.get("res_z") or 0.05), "offset_z": float(m.get("offset_z") or 0),
            "water_level": float(m.get("water_level") or 0), "grid": [nx, ny], "origin": m.get("origin"),
            # world extent: tile (origin) starts at origin * tile side metres from the map centre
            "bounds": [float(m["origin"][0]) * side_m, float(m["origin"][1]) * side_m,
                       (float(m["origin"][0]) + nx) * side_m, (float(m["origin"][1]) + ny) * side_m],
            "raw_min": self.lo, "raw_max": self.hi, "revs": self.revs, "bytes": len(png),
            "complete": complete, "bands_done": self.n_done, "bands_total": self.total,
            "rows_ready": None if complete else self.rows_ready(),
        }
        path.with_suffix(".json").write_text(json.dumps(meta), encoding="utf-8")
        self.written_bands = self.n_done
        return meta
