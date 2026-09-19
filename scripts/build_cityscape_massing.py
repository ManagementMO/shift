"""Extract Toronto's 2025 massing into a render-only asset. Does not modify SUMO.
Run with uv run --no-project --python 3.12 --with fiona --with pyproj --with shapely python scripts/build_cityscape_massing.py
"""
from pathlib import Path
import json
import math
import fiona
from pyproj import Transformer
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
world = json.loads((ROOT / 'var/citypacks/toronto/world.json').read_text())
crs = world['crs']
project = Transformer.from_crs('EPSG:3857', crs['proj'], always_xy=True)
mercator = Transformer.from_crs(4326, 3857, always_xy=True)
ox = crs['net_offset'][0] - crs['origin_net'][0]
oz = crs['net_offset'][1] - crs['origin_net'][1]

def polygon(ring):
    return Polygon(list(zip(ring[::2], ring[1::2]))).buffer(0)

landmarks = [polygon(l['ring']).buffer(3) for l in world['landmarks']]
osm = world['buildings']
osm_polys = [polygon(b['ring']) for b in osm]
osm_index = STRtree(osm_polys)
bbox = (*mercator.transform(-79.41, 43.632), *mercator.transform(-79.367, 43.663))
gdb = ROOT / 'var/cityscape-source/3DMassingMultipatch_2025_WGS84.gdb'
with fiona.open(gdb, layer='Context_Tiles') as source:
    tiles = {dict(f['properties'])['Tile_Name'] for f in source.filter(bbox=bbox)}
layers = [l for l in fiona.listlayers(gdb) if l.startswith('Multipatch_') and l.removeprefix('Multipatch_') in tiles]
features, footprints, seen = [], [], set()
for layer in layers:
    with fiona.open(gdb, layer=layer) as source:
        for f in source.filter(bbox=bbox):
            geometry = f['geometry']
            if not geometry or geometry['type'] != 'MultiPolygon': continue
            faces, roofs, heights = [], [], []
            for surface in geometry['coordinates']:
                rings = []
                for ring in surface:
                    pts = []
                    for lon, lat, elevation in ring:
                        x, z = project.transform(lon, lat)
                        pts.append([round(x + ox, 2), round(elevation, 2), round(z + oz, 2)])
                        heights.append(elevation)
                    if len(pts) > 1 and pts[0] == pts[-1]: pts.pop()
                    if len(pts) >= 3: rings.append(pts)
                if not rings: continue
                faces.append([[v for p in ring for v in p] for ring in rings])
                if max(p[1] for p in rings[0]) - min(p[1] for p in rings[0]) < 0.05:
                    roof = Polygon([(p[0], p[2]) for p in rings[0]], [[(p[0], p[2]) for p in r] for r in rings[1:]]).buffer(0)
                    if not roof.is_empty and roof.area > 1: roofs.append(roof)
            if not roofs or not heights or max(heights) < 5: continue
            footprint = unary_union(roofs)
            center = footprint.centroid
            if math.hypot(center.x - 179.1, center.y + 662.1) > 1550: continue
            if any(footprint.intersection(l).area > min(footprint.area, l.area) * 0.18 for l in landmarks): continue
            key = (round(center.x, 1), round(center.y, 1), round(max(heights), 1), round(footprint.area))
            if key in seen: continue
            seen.add(key)
            match = max(osm_index.query(footprint), key=lambda i: footprint.intersection(osm_polys[i]).area, default=None)
            cat = osm[int(match)]['cat'] if match is not None else ('office' if max(heights) > 60 else 'generic')
            features.append({'id': f'{layer}:{f.id}', 'cat': cat, 'h': round(max(heights), 2), 'x': round(center.x, 2), 'z': round(center.y, 2), 'faces': faces})
            footprints.append(footprint)
index = STRtree(footprints)
excluded = []
for b, p in zip(osm, osm_polys):
    if b.get('lm') or b['cat'] == 'landmark' or p.is_empty: continue
    near = index.query(p)
    if len(near) and unary_union([footprints[int(i)] for i in near]).intersection(p).area > p.area * 0.4:
        excluded.append(b['id'])
result = {'version': 1, 'network_fingerprint': world['network_fingerprint'], 'source': 'City of Toronto 3D Massing, 2025', 'source_url': 'https://open.toronto.ca/dataset/3d-massing/', 'license': 'Open Government Licence - Toronto', 'excluded_osm_ids': excluded, 'buildings': features}
out = ROOT / 'var/cityscape-source/downtown-raw.json'
out.write_text(json.dumps(result, separators=(',', ':')))
print(json.dumps({'buildings': len(features), 'osm_replaced': len(excluded), 'faces': sum(len(f['faces']) for f in features), 'bytes': out.stat().st_size}))
