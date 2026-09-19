"""Reproducible city-pack pipeline: OSM tiles -> netconvert -> pack artifacts.

    python -m cityshift.citypack.make_pack toronto           # builds var/citypacks/toronto (skips steps whose outputs exist)
    python -m cityshift.citypack.make_pack waterloo --force  # rebuild netconvert + pack artifacts
    python -m cityshift.citypack.make_pack toronto --pack-only  # re-derive pack.json/geojson from the existing net

The netconvert options below are the ones recorded in the header of the shipped waterloo.net.xml, so a
rebuild reproduces the same network given the same OSM tiles.  OSM tiles are cached under var/osm/<pack_id>/.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from cityshift.citypack.build import CITIES, PACK_ROOT, CityConfig, build_pack
from cityshift.citypack.osm_fetch import fetch_tiles
from cityshift.transport.sumo_env import binary

NETCONVERT_OPTS = [
    "--output.street-names", "true",
    "--output.original-names", "true",
    "--proj.utm", "true",
    "--geometry.remove", "true",
    "--tls.discard-simple", "true",
    "--tls.join", "true",
    "--tls.guess-signals", "true",
    "--tls.default-type", "actuated",
    "--ramps.guess", "true",
    "--keep-edges.by-vclass", "passenger,bus,pedestrian",
    "--remove-edges.by-vclass", "rail,rail_urban,tram,ship,aircraft",
    "--no-turnarounds.except-deadend", "true",
    "--junctions.join", "true",
    "--junctions.corner-detail", "5",
    "--sidewalks.guess", "true",
    "--crossings.guess", "true",
    "--osm.sidewalks", "true",
    "--osm.stop-output.length", "20",
    "--osm.stop-output.length.bus", "25",
]


def osm_dir(cfg: CityConfig) -> Path:
    return PACK_ROOT.parent / "osm" / cfg.pack_id


def run_netconvert(cfg: CityConfig, tiles: list[Path], pack_dir: Path) -> None:
    pack_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        binary("netconvert"),
        "--osm-files", ",".join(str(t) for t in tiles),
        "--output-file", str(pack_dir / cfg.net_name),
        "--ptstop-output", str(pack_dir / "stops.add.xml"),
        "--ptline-output", str(pack_dir / "ptlines.xml"),
        *NETCONVERT_OPTS,
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError(f"netconvert failed: {res.stderr[-2000:]}")


def make_pack(cfg: CityConfig, force: bool = False, pack_only: bool = False) -> Path:
    pack_dir = PACK_ROOT / cfg.pack_id
    if not pack_only:
        tiles = sorted(fetch_tiles(cfg.osm_bbox, osm_dir(cfg)))
        if force or not (pack_dir / cfg.net_name).exists():
            print(f"netconvert over {len(tiles)} OSM tiles ...", file=sys.stderr)
            run_netconvert(cfg, tiles, pack_dir)
    if force or pack_only or not (pack_dir / "pack.json").exists():
        pack = build_pack(cfg, pack_dir)
        print(f"{pack.pack_id}: {len(pack.stops)} stops, {len(pack.zones)} zones, fingerprint {pack.network_fingerprint}")
    else:
        print(f"{pack_dir} already built; pass --force to rebuild")
    return pack_dir


def main(argv: list[str]) -> int:
    names = [a for a in argv if not a.startswith("--")] or ["waterloo"]
    for name in names:
        make_pack(CITIES[name], force="--force" in argv, pack_only="--pack-only" in argv)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
