"""City-pack builder: declared shuttle bays land on real bus-permitted lanes and survive reloads."""

from __future__ import annotations

from pathlib import Path

import pytest
import sumolib

from cityshift.citypack.build import ExtraStopSpec, ensure_extra_stops, load_stops
from cityshift.transport.sumo_xml import write_additional
from cityshift.transport.tiny_fixture import STOPS, build_tiny_network

FIX = Path(__file__).parent / "_out"


@pytest.fixture(scope="module")
def net_path() -> Path:
    return build_tiny_network(FIX / "tiny", geo=True)


def test_extra_stop_is_placed_on_bus_lane_and_is_idempotent(tmp_path: Path, net_path: Path):
    net = sumolib.net.readNet(str(net_path))
    stops_xml = tmp_path / "stops.add.xml"
    write_additional(stops_xml, STOPS)
    before = len(load_stops(net, stops_xml))

    # a point beside e_BC (x=450, y=5) in the tiny net's local frame
    lon, lat = net.convertXY2LonLat(450.0, 5.0)
    spec = ExtraStopSpec("SB_VENUE", "Venue shuttle bay (declared)", (lon, lat))

    added = ensure_extra_stops(net, stops_xml, (spec,))
    assert added == ["SB_VENUE"]
    stops = load_stops(net, stops_xml)
    assert len(stops) == before + 1
    bay = next(s for s in stops if s.stop_id == "SB_VENUE")
    assert bay.edge_id == "e_BC"
    assert net.getLane(f"e_BC_{bay.lane_index}").allows("bus")
    assert 0 <= bay.start_pos < bay.end_pos <= net.getEdge("e_BC").getLength()
    assert bay.name.endswith("(declared)")

    # second call must not duplicate the stop
    assert ensure_extra_stops(net, stops_xml, (spec,)) == []
    assert len(load_stops(net, stops_xml)) == before + 1
    assert stops_xml.read_text().count('id="SB_VENUE"') == 1
