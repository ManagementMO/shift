from itertools import combinations

from shapely.geometry import Polygon, box
from shapely.ops import unary_union

from cityshift.citypack.world import OsmData, compile_areas, compile_buildings


class IdentityFrame:
    def lonlat_to_world(self, x, y):
        return x, y


def osm_square(tags, key="1", x=0):
    refs = [f"{key}-{i}" for i in range(4)]
    nodes = dict(zip(refs, [(x, 0), (x + 20, 0), (x + 20, 20), (x, 20)], strict=True))
    return OsmData(nodes=nodes, ways={key: ([*refs, refs[0]], tags)})


def test_building_clearance_is_preserved_instead_of_lowering_the_roof():
    osm = osm_square({"building": "office", "height": "30", "min_height": "10"})
    buildings, _ = compile_buildings(osm, IdentityFrame(), box(-100, -100, 100, 100))
    assert buildings[0]["base"] == 10
    assert buildings[0]["h"] == 20
    assert buildings[0]["base"] + buildings[0]["h"] == 30


def test_min_level_clearance_and_zero_base():
    osm = osm_square({"building": "yes", "building:levels": "8", "building:min_level": "2"})
    buildings, _ = compile_buildings(osm, IdentityFrame(), box(-100, -100, 100, 100))
    assert buildings[0]["base"] == 6.6
    ground, _ = compile_buildings(osm_square({"building": "yes"}), IdentityFrame(), box(-100, -100, 100, 100))
    assert ground[0]["base"] == 0


def test_park_relations_do_not_duplicate_member_surfaces():
    osm = osm_square({"leisure": "park"})
    osm.relations["park"] = ([("way", "1", "outer")], {"type": "multipolygon", "leisure": "park"})
    green, _, _ = compile_areas(osm, IdentityFrame(), box(-100, -100, 100, 100))
    assert len(green) == 1


def test_surface_partition_has_no_overlap_or_gaps_at_shoreline_and_crossings():
    from cityshift.citypack.world import compile_surfaces

    def area(x0, y0, x1, y1):
        return {"ring": [x0, y0, x1, y0, x1, y1, x0, y1]}

    roads = [
        {"kind": "path", "w": 3, "shape": [0, 8.2, 30, 19.7]},
        {"kind": "path", "w": 3, "shape": [0, 8.2, 30, 19.7]},
        {"kind": "road", "lanes": [{"w": 4, "shape": [10, 0, 10, 30], "allow": ["car"]}]},
    ]
    water = [area(20, 0, 30, 30)]
    green = [area(0, 0, 25, 30), area(0, 0, 25, 30)]
    green[0]["holes"] = [[2, 2, 5, 2, 5, 5, 2, 5]]
    surfaces = compile_surfaces(box(0, 0, 30, 30), roads, [], green, [area(0, 0, 30, 4)], [], water)
    layers = {}
    for kind, areas in surfaces.items():
        layers[kind] = unary_union([
            Polygon(list(zip(a["ring"][::2], a["ring"][1::2])),
                    [list(zip(h[::2], h[1::2])) for h in a.get("holes", [])])
            for a in areas
        ])
    for a, b in combinations(layers.values(), 2):
        assert a.intersection(b).area < 0.01
    assert layers["grass"].intersection(box(20, 0, 30, 30)).area < 0.01
    land = box(0, 0, 20, 30)
    assert land.difference(unary_union(list(layers.values()))).area < 0.01


def test_tower_and_podium_do_not_draw_coincident_facades():
    from cityshift.citypack.world import resolve_building_volumes

    ring = [0, 0, 20, 0, 20, 20, 0, 20]
    buildings = [
        {"id": "tower", "ring": ring, "base": 0, "h": 120, "cat": "tower"},
        {"id": "podium", "ring": ring, "base": 0, "h": 30, "cat": "apartments"},
    ]
    resolved = resolve_building_volumes(buildings)
    assert len(resolved) == 2
    podium = next(b for b in resolved if b["source_id"] == "podium")
    tower = next(b for b in resolved if b["source_id"] == "tower")
    assert (podium["base"], podium["h"]) == (0, 30)
    assert (tower["base"], tower["h"]) == (30, 90)
    assert podium["roofs"] == []
    assert tower["roofs"]
    assert tower["source_height"] == 120
    assert buildings[0]["base"] == 0


def test_podium_roof_is_cut_around_tower_and_volumes_are_disjoint():
    from cityshift.citypack.world import resolve_building_volumes

    buildings = [
        {"id": "podium", "ring": [0, 0, 30, 0, 30, 30, 0, 30], "base": 0, "h": 20, "cat": "apartments"},
        {"id": "tower", "ring": [5, 5, 25, 5, 25, 25, 5, 25], "base": 0, "h": 100, "cat": "tower"},
    ]
    resolved = resolve_building_volumes(buildings)
    for a, b in combinations(resolved, 2):
        vertical = min(a["base"] + a["h"], b["base"] + b["h"]) - max(a["base"], b["base"])
        pa = Polygon(list(zip(a["ring"][::2], a["ring"][1::2])))
        pb = Polygon(list(zip(b["ring"][::2], b["ring"][1::2])))
        assert vertical <= 0 or pa.intersection(pb).area < 1e-6
    podium = next(b for b in resolved if b["source_id"] == "podium")
    roof = podium["roofs"][0]
    poly = Polygon(list(zip(roof["ring"][::2], roof["ring"][1::2])),
                   [list(zip(h[::2], h[1::2])) for h in roof["holes"]])
    assert poly.area == 500
    assert len(roof["holes"]) == 1


def test_separated_vertical_buildings_are_not_rewritten():
    from cityshift.citypack.world import resolve_building_volumes

    ring = [0, 0, 20, 0, 20, 20, 0, 20]
    buildings = [{"id": "a", "ring": ring, "base": 0, "h": 5, "cat": "generic"},
                 {"id": "b", "ring": ring, "base": 10, "h": 10, "cat": "generic"}]
    assert resolve_building_volumes(buildings) == buildings


def test_park_courtyards_survive_surface_compilation():
    from cityshift.citypack.world import compile_surfaces

    green = [{"ring": [0, 0, 20, 0, 20, 20, 0, 20], "holes": [[5, 5, 10, 5, 10, 10, 5, 10]]}]
    surfaces = compile_surfaces(box(0, 0, 20, 20), [], [], green, [], [], [])
    assert surfaces["grass"][0]["holes"]
    assert sum(Polygon(list(zip(a["ring"][::2], a["ring"][1::2]))).area for a in surfaces["ground"]) == 25
