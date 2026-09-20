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


def test_incident_requests_carry_a_place_a_footprint_and_a_hazard_profile():
    from cityshift.live.contracts import HAZARDS, InterventionRequest

    request = InterventionRequest.model_validate({
        "command_id": "crash-1", "at_s": 30, "expected_revision": 2,
        "intervention": {"kind": "incident", "hazard": "crash", "lon": -79.38, "lat": 43.64, "radius_m": 90},
    })
    assert request.intervention.duration_s is None
    assert request.intervention.effective_duration_s == HAZARDS["crash"].default_duration_s
    assert request.intervention.alarm_radius_m > request.intervention.radius_m
    assert "pedestrian" not in HAZARDS["crash"].blocks
    assert "pedestrian" in HAZARDS["fire"].blocks


@pytest.mark.parametrize("intervention", [
    {"kind": "incident", "hazard": "meteor", "lon": -79.38, "lat": 43.64},
    {"kind": "incident", "hazard": "fire", "lon": -79.38, "lat": 95},
    {"kind": "incident", "hazard": "fire", "lon": -79.38, "lat": 43.64, "radius_m": 5},
    {"kind": "incident", "hazard": "fire", "lon": -79.38, "lat": 43.64, "duration_s": 5},
    {"kind": "incident", "hazard": "fire", "lon": -79.38, "lat": 43.64, "label": "x" * 80},
    {"kind": "incident", "hazard": "fire", "lon": math.nan, "lat": 43.64},
])
def test_incidents_reject_unknown_hazards_and_impossible_footprints(intervention):
    from cityshift.live.contracts import InterventionRequest

    with pytest.raises(ValidationError):
        InterventionRequest(command_id="bad", at_s=0, expected_revision=0, intervention=intervention)


def test_cold_response_changes_mobility_without_creating_road_ice():
    from cityshift.live.contracts import temperature_response

    mild = temperature_response(20)
    cold = temperature_response(0)
    assert cold.walk_speed_factor < mild.walk_speed_factor
    assert cold.walk_tolerance_factor < mild.walk_tolerance_factor
    assert cold.walk_speed_factor > 0
    assert cold.road_speed_factor == mild.road_speed_factor == 1
    assert cold.model_version == mild.model_version


def test_stored_incident_commands_load_again_without_their_derived_fields():
    from cityshift.live.contracts import IncidentChange, InterventionRequest, stored_command

    request = InterventionRequest(command_id="c1", at_s=10, expected_revision=0, intervention=IncidentChange(kind="incident", hazard="storm", lon=-79.38, lat=43.64, radius_m=120))
    dumped = request.model_dump(mode="json")
    assert {"effective_duration_s", "alarm_radius_m"} <= dumped["intervention"].keys()
    stored = request.stored()
    assert not ({"effective_duration_s", "alarm_radius_m"} & stored["intervention"].keys())
    assert InterventionRequest.model_validate(stored) == request
    # a session.json written before this fix still carries the derived fields
    assert InterventionRequest.model_validate(stored_command(dumped)) == request
