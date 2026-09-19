"""Download OpenStreetMap data for a bbox via the OSM 0.6 `map` API in tiles that stay under the
50 000-node limit.  Produces one .osm file per tile; netconvert merges them."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx

OSM_API = "https://api.openstreetmap.org/api/0.6/map"
OVERPASS_API = "https://overpass-api.de/api/interpreter"
UA = "cityshift/0.1 (transport scenario lab; contact via repo)"


def fetch_shoreline(bbox: tuple[float, float, float, float], out_dir: Path, lake_relations: tuple[int, ...]) -> list[Path]:
    """Overpass pull of the big-water geometry the tile API cannot give us: member ways of the named lake
    relations that touch the (padded) bbox, plus every other natural=water way/relation in it.  Used only by the
    world compiler for the Babylon miniature."""
    out_dir.mkdir(parents=True, exist_ok=True)
    minlon, minlat, maxlon, maxlat = bbox
    pad = 0.01
    bb = f"{minlat - pad},{minlon - pad},{maxlat + pad},{maxlon + pad}"
    queries = {
        "lake_ways.json": f"[out:json][timeout:150][bbox:{bb}];(" + "".join(f"rel({rid});way(r);" for rid in lake_relations) + ");out geom;",
        "lake.json": f'[out:json][timeout:150];(way["natural"="water"]({bb});relation["natural"="water"](if:t["name"]!="Lake Ontario")({bb});way(r)({bb}););out geom;',
    }
    files: list[Path] = []
    with httpx.Client(timeout=240, headers={"User-Agent": UA}) as client:
        for name, query in queries.items():
            path = out_dir / name
            if path.exists() and path.stat().st_size > 1000:
                files.append(path)
                continue
            for attempt in range(4):
                r = client.post(OVERPASS_API, data={"data": query})
                if r.status_code == 200:
                    path.write_bytes(r.content)
                    files.append(path)
                    print(f"shoreline {name}: {len(r.content)/1e6:.1f} MB", file=sys.stderr)
                    break
                print(f"shoreline {name}: HTTP {r.status_code}, retry {attempt}", file=sys.stderr)
                time.sleep(10 * (attempt + 1))
            else:
                print(f"shoreline {name}: giving up; world will have no large water bodies", file=sys.stderr)
    return files


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
    a, b, c, d = (float(x) for x in sys.argv[1].split(","))  # minlon,minlat,maxlon,maxlat
    bbox = (a, b, c, d)
    out = Path(sys.argv[2])
    print("\n".join(str(p) for p in fetch_tiles(bbox, out)))
