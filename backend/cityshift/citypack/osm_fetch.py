"""Download OpenStreetMap data for a bbox via the OSM 0.6 `map` API in tiles that stay under the
50 000-node limit.  Produces one .osm file per tile; netconvert merges them."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx

OSM_API = "https://api.openstreetmap.org/api/0.6/map"
UA = "cityshift/0.1 (transport scenario lab; contact via repo)"


def fetch_tiles(bbox: tuple[float, float, float, float], out_dir: Path, nx: int = 4, ny: int = 4) -> list[Path]:
    minlon, minlat, maxlon, maxlat = bbox
    out_dir.mkdir(parents=True, exist_ok=True)
    files: list[Path] = []
    dlon = (maxlon - minlon) / nx
    dlat = (maxlat - minlat) / ny
    with httpx.Client(timeout=240, headers={"User-Agent": UA}) as client:
        for i in range(nx):
            for j in range(ny):
                b = (minlon + i * dlon, minlat + j * dlat, minlon + (i + 1) * dlon, minlat + (j + 1) * dlat)
                path = out_dir / f"tile_{i}_{j}.osm"
                if path.exists() and path.stat().st_size > 1000:
                    files.append(path)
                    continue
                for attempt in range(4):
                    r = client.get(OSM_API, params={"bbox": ",".join(f"{v:.5f}" for v in b)})
                    if r.status_code == 200:
                        path.write_bytes(r.content)
                        files.append(path)
                        print(f"tile {i},{j}: {len(r.content)/1e6:.1f} MB", file=sys.stderr)
                        break
                    if r.status_code == 400 and b"too many nodes" in r.content:
                        # split this tile into 4 and recurse
                        files.extend(fetch_tiles(b, out_dir / f"sub_{i}_{j}", 2, 2))
                        break
                    print(f"tile {i},{j}: HTTP {r.status_code}, retry {attempt}", file=sys.stderr)
                    time.sleep(5 * (attempt + 1))
                else:
                    raise RuntimeError(f"OSM tile {b} failed")
    return files


if __name__ == "__main__":
    bbox = tuple(float(x) for x in sys.argv[1].split(","))  # minlon,minlat,maxlon,maxlat
    out = Path(sys.argv[2])
    print("\n".join(str(p) for p in fetch_tiles(bbox, out)))
