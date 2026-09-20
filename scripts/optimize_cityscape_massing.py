"""Simplify the raw official surface extract into roof-derived massing tiers.
uv run --no-project --python 3.12 --with shapely python scripts/optimize_cityscape_massing.py
"""
from pathlib import Path
import json
from collections import defaultdict
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree
ROOT = Path(__file__).resolve().parents[1]
payload = json.loads((ROOT/'var/cityscape-source/downtown-raw.json').read_text())
output=[]

def polygons(g):
    if g.geom_type == 'Polygon': return [g]
    return [p for p in getattr(g, 'geoms', []) if p.geom_type == 'Polygon']

def ring(coords):
    return [round(v,2) for p in list(coords)[:-1] for v in p]

for i,b in enumerate(payload['buildings']):
    planes=defaultdict(list)
    for face in b.pop('faces'):
        outer=face[0]
        ys=outer[1::3]
        if not ys or max(ys)-min(ys)>0.08 or max(ys)<3: continue
        p=Polygon(list(zip(outer[::3],outer[2::3])),[list(zip(h[::3],h[2::3])) for h in face[1:]]).buffer(0)
        if not p.is_empty and p.area>.2: planes[round(sum(ys)/len(ys)*4)/4].append(p)
    roofs=[]
    for y,parts in planes.items():
        g=unary_union(parts).buffer(0).simplify(0.32,preserve_topology=True)
        if g.area>8: roofs.append((y,g))
    if not roofs: continue
    # Keep meaningful massing levels. Fine balcony edges and rooftop machinery are handled by appearance.
    maximum=max(g.area for _,g in roofs)
    roofs=sorted([(y,g) for y,g in roofs if g.area>max(8,maximum*.018)],reverse=True,key=lambda r:r[0])[:48]
    cumulative=None
    tiers=[]
    for j,(y,g) in enumerate(roofs):
        cumulative=g if cumulative is None else cumulative.union(g).buffer(0)
        below=roofs[j+1][0] if j+1<len(roofs) else 0
        if y-below<.3: continue
        for p in polygons(cumulative.simplify(.4,preserve_topology=True)):
            if p.area<8: continue
            tiers.append({'y0':below,'y1':y,'ring':ring(p.exterior.coords),'holes':[ring(h.coords) for h in p.interiors if Polygon(h).area>4]})
    if tiers:
        b['tiers']=tiers
        output.append(b)
    if i%200==0: print(f'Optimized {i}/{len(payload["buildings"])} buildings',flush=True)
payload['buildings']=output
# Only suppress fallback footprints that overlap buildings retained in the final asset.
world=json.loads((ROOT/'var/citypacks/toronto/world.json').read_text())
footprints=[unary_union([Polygon(list(zip(t['ring'][::2],t['ring'][1::2])),[list(zip(h[::2],h[1::2])) for h in t['holes']]).buffer(0) for t in b['tiers']]) for b in output]
index=STRtree(footprints)
excluded=[]
for b in world['buildings']:
    if b.get('lm') or b['cat']=='landmark': continue
    p=Polygon(list(zip(b['ring'][::2],b['ring'][1::2])),[list(zip(h[::2],h[1::2])) for h in b.get('holes',[])]).buffer(0)
    if p.is_empty: continue
    near=index.query(p)
    if len(near) and unary_union([footprints[int(i)] for i in near]).intersection(p).area>p.area*.4:
        excluded.append(b['id'])
payload['excluded_osm_ids']=excluded
payload['geometry_note']='Roof-derived massing tiers simplified to 0.4 m; appearance and landmarks are illustrative.'
out=ROOT/'frontend/public/assets/city/toronto-massing.json'
out.write_text(json.dumps(payload,separators=(',',':')))
print(json.dumps({'buildings':len(output),'tiers':sum(len(b['tiers']) for b in output),'bytes':out.stat().st_size}))
