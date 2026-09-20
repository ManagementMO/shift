from collections.abc import Iterable
from itertools import pairwise

from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree


def iter_polys(geom) -> Iterable[Polygon]:
    if isinstance(geom, Polygon):
        if not geom.is_empty:
            yield geom
    elif isinstance(geom, MultiPolygon):
        for g in geom.geoms:
            if not g.is_empty:
                yield g
    elif hasattr(geom, "geoms"):
        for g in geom.geoms:
            yield from iter_polys(g)


def polygon_shape(area: dict):
    return Polygon(list(zip(area["ring"][::2], area["ring"][1::2], strict=True)),
                   [list(zip(h[::2], h[1::2], strict=True)) for h in area.get("holes", [])]).buffer(0)


def polygon_record(poly: Polygon) -> dict:
    return {
        "ring": [v for point in list(poly.exterior.coords)[:-1] for v in point],
        "holes": [[v for point in list(h.coords)[:-1] for v in point] for h in poly.interiors],
    }


def resolve_building_volumes(buildings: list[dict], preserve_landmarks: bool = True) -> list[dict]:
    if not buildings:
        return []
    shapes = [polygon_shape(b) for b in buildings]
    bases = [b.get("base", 0) for b in buildings]
    tops = [base + b["h"] for base, b in zip(bases, buildings, strict=True)]
    tree = STRtree(shapes)
    parents = list(range(len(buildings)))

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for i, shape in enumerate(shapes):
        if preserve_landmarks and buildings[i]["cat"] == "landmark":
            continue
        for index in tree.query(shape, predicate="intersects"):
            j = int(index)
            if j <= i or (preserve_landmarks and buildings[j]["cat"] == "landmark"):
                continue
            if min(tops[i], tops[j]) < max(bases[i], bases[j]) - 1e-6:
                continue
            if shape.intersection(shapes[j]).area > 0.01:
                parents[root(j)] = root(i)
    groups: dict[int, list[int]] = {}
    for i in range(len(buildings)):
        groups.setdefault(root(i), []).append(i)
    out: list[dict] = []
    for group in groups.values():
        if len(group) == 1:
            out.append(buildings[group[0]])
            continue
        levels = sorted({v for i in group for v in (bases[i], tops[i])})
        for low, high in pairwise(levels):
            if high - low <= 1e-6:
                continue
            active = sorted((i for i in group if bases[i] <= low and tops[i] >= high),
                            key=lambda i: (tops[i], shapes[i].area, buildings[i]["id"]))
            occupied = Polygon()
            above = unary_union([shapes[i] for i in group if bases[i] <= high and tops[i] > high])
            for i in active:
                visible = shapes[i].difference(occupied)
                occupied = unary_union([occupied, shapes[i]])
                source = buildings[i]
                for part, poly in enumerate(iter_polys(visible)):
                    if poly.area < 0.01:
                        continue
                    out.append({**source, **polygon_record(poly), "id": f'{source["id"]}:volume:{low:g}:{part}',
                                "source_id": source.get("source_id", source["id"]),
                                "source_height": source.get("source_height", source["h"]),
                                "base": low, "h": high - low,
                                "roofs": [polygon_record(p) for p in iter_polys(poly.difference(above)) if p.area >= 0.01]})
    return out
