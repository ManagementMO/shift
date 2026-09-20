import pytest
import sumolib

from cityshift.live.contracts import PopulationChange, SessionConfig
from cityshift.live.network import LiveNetwork
from cityshift.live.population import Population
from cityshift.live.transit import Transit


@pytest.mark.parametrize("length", [0.2, 0.8, 300.0])
def test_spawn_positions_remain_inside_even_twenty_centimeter_segments(live_pack, length):
    net = sumolib.net.readNet(live_pack.net_file)
    for lane in net.getEdge("e_AB").getLanes():
        lane._length = length
    config = SessionConfig(pack_id=live_pack.pack_id, initial_population=0, car_share=0)
    network = LiveNetwork(net, None, (0, 0))
    entities = []
    people = Population(network, Transit(network, live_pack, config, entities), live_pack, config, entities)
    people.add(PopulationChange(kind="population", count=30, origin_zone_id="Z_WEST", destination_zone_id="Z_EAST", release_window_s=0), "short-segment", 0)
    assert all(0 <= t.position <= length for t in people.trips.values())
    assert len(people.trips) == 30
