import math

import pytest
from pydantic import ValidationError


def test_session_accepts_5000_real_travelers_with_a_finite_fleet():
    from cityshift.live.contracts import SessionConfig

    config = SessionConfig(pack_id="toronto", initial_population=5000, fleet_size=2)
    assert config.initial_population == 5000
    assert config.fleet_size == 2
    assert config.temperature_c == 20


@pytest.mark.parametrize("values", [
    {"pack_id": "../toronto"},
    {"pack_id": "toronto", "initial_population": 10001},
    {"pack_id": "toronto", "initial_population": -1},
    {"pack_id": "toronto", "temperature_c": math.nan},
    {"pack_id": "toronto", "fleet_size": 33},
])
def test_session_rejects_unsafe_or_unbounded_inputs(values):
    from cityshift.live.contracts import SessionConfig

    with pytest.raises(ValidationError):
        SessionConfig(**values)


def test_intervention_request_preserves_the_playhead_and_command_identity():
    from cityshift.live.contracts import InterventionRequest

    request = InterventionRequest.model_validate({
        "command_id": "operator-1", "at_s": 42, "expected_revision": 0,
        "intervention": {"kind": "population", "count": 5000, "destination_zone_id": "Z_FIN", "release_window_s": 300},
    })
    assert request.at_s == 42
    assert request.intervention.count == 5000
    assert request.command_id == "operator-1"


@pytest.mark.parametrize("intervention", [
    {"kind": "temperature", "temperature_c": math.inf},
    {"kind": "temperature", "temperature_c": -80},
    {"kind": "population", "count": 0, "destination_zone_id": "Z_FIN"},
    {"kind": "close_road", "edge_ids": []},
    {"kind": "add_bus_route", "bus_id": "bus_A", "stop_ids": ["one"]},
    {"kind": "temperature", "temperature_c": 0, "invented_outcome": 5000},
])
def test_interventions_reject_invalid_values_before_touching_sumo(intervention):
    from cityshift.live.contracts import InterventionRequest

    with pytest.raises(ValidationError):
        InterventionRequest(command_id="operator-1", at_s=42, expected_revision=0, intervention=intervention)


def test_cold_response_changes_mobility_without_creating_road_ice():
    from cityshift.live.contracts import temperature_response

    mild = temperature_response(20)
    cold = temperature_response(0)
    assert cold.walk_speed_factor < mild.walk_speed_factor
    assert cold.walk_tolerance_factor < mild.walk_tolerance_factor
    assert cold.walk_speed_factor > 0
    assert cold.road_speed_factor == mild.road_speed_factor == 1
    assert cold.model_version == mild.model_version
