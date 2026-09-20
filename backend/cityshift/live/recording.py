from __future__ import annotations

import json
import math
import struct
import threading
from collections.abc import Iterable, Iterator
from pathlib import Path

CHUNK_SECONDS = 10
HEADER = struct.Struct("<4sII8If")
ROW = struct.Struct("<IffffBBH")
COUNT_KEYS = ("total", "not_departed", "walking", "waiting", "riding", "driving", "arrived", "unroutable")
FrameRow = tuple[int, float, float, float, float, int, int] | tuple[int, float, float, float, float, int, int, int]


def atomic_json(path: Path, value: object) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, separators=(",", ":"), allow_nan=False))
    tmp.replace(path)


def frame_spans(data: bytes) -> Iterator[tuple[int, int, int]]:
    offset = 0
    while offset < len(data):
        if len(data) - offset < HEADER.size:
            raise ValueError("incomplete frame header")
        header = HEADER.unpack_from(data, offset)
        end = offset + HEADER.size + header[2] * ROW.size
        if header[0] != b"CSF1" or header[2] > 10032 or end > len(data):
            raise ValueError("invalid frame payload")
        yield header[1], offset, end
        offset = end


def encode_frame(t: int, rows: Iterable[FrameRow], counts: dict[str, int], temperature: float) -> bytes:
    numbers = [counts.get(key, 0) for key in COUNT_KEYS]
    if any(not isinstance(n, int) or n < 0 or n > 10000 for n in numbers) or sum(numbers[1:]) != numbers[0]:
        raise ValueError("cohort counts must account for every traveler exactly once")
    ordered = sorted(rows, key=lambda row: row[0])
    if len(ordered) > 10032 or not math.isfinite(temperature):
        raise ValueError("invalid frame size or temperature")
    data = bytearray(HEADER.pack(b"CSF1", t, len(ordered), *numbers, temperature))
    previous = -1
    for row in ordered:
        index, x, z, angle, speed, kind, state = row[:7]
        flags = row[7] if len(row) > 7 else 0
        if index <= previous or not all(math.isfinite(v) for v in (x, z, angle, speed)):
            raise ValueError("entity indices must be unique and measurements finite")
        if not 0 <= index < 2**32 or kind not in (1, 2, 3) or not 0 <= state <= 6 or not 0 <= flags < 2**16:
            raise ValueError("invalid entity identity, state or flags")
        data.extend(ROW.pack(index, x, z, angle, speed, kind, state, flags))
        previous = index
    return bytes(data)


class FrameStore:
    latest_s: int

    def __init__(self, root: Path, parent: FrameStore | None = None, fork_s: int | None = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.parent = parent
        self.fork_s = fork_s
        self.lock = threading.RLock()
        if parent is not None and (fork_s is None or fork_s < 0 or fork_s > parent.latest_s or parent.root == self.root):
            raise ValueError("branch time must exist in its parent recording")
        index = self.root / "index.json"
        self.latest_s = int(json.loads(index.read_text())["latest_s"]) if index.exists() else (fork_s if parent and fork_s is not None else -1)

    def append(self, t: int, rows: Iterable[FrameRow], counts: dict[str, int], temperature: float) -> None:
        with self.lock:
            if t != self.latest_s + 1:
                raise ValueError("recorded time must advance exactly one second without overwrites")
            data = encode_frame(t, rows, counts, temperature)
            with self._path(t - t % CHUNK_SECONDS).open("ab") as output:
                output.write(data)
            self.latest_s = t
            atomic_json(self.root / "index.json", {"latest_s": t})

    def read_chunk(self, start: int) -> bytes:
        if start < 0 or start % CHUNK_SECONDS:
            raise ValueError("chunk start must be a nonnegative multiple of 10")
        with self.lock:
            if start > self.latest_s:
                raise KeyError("time has not been simulated")
            prefix = b""
            if self.parent is not None and self.fork_s is not None and start <= self.fork_s:
                data = self.parent.read_chunk(start)
                prefix = b"".join(data[a:b] for t, a, b in frame_spans(data) if t <= self.fork_s)
            path = self._path(start)
            own = path.read_bytes() if path.exists() else b""
            return prefix + own

    def _path(self, start: int) -> Path:
        return self.root / f"chunk-{start:06d}.bin"
