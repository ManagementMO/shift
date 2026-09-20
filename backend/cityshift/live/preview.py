from __future__ import annotations

from itertools import pairwise

from cityshift.contracts import CityPack
from cityshift.domain.network import route
from cityshift.live.contracts import (
    HAZARDS,
    MAX_TRAVELERS,
    BusRouteChange,
    DevelopmentChange,
    IncidentChange,
    InterventionRequest,
    PopulationChange,
    RemoveDevelopmentChange,
    RoadChange,
    SessionConfig,
    TemperatureChange,
    temperature_response,
)
from cityshift.live.developments import resolve_access, trip_counts
from cityshift.live.network import LiveNetwork


def preview(pack: CityPack, config: SessionConfig, state: dict, request: InterventionRequest, net) -> dict:
    if request.expected_revision != state["revision"]:
        raise ValueError("session revision changed; refresh before previewing")
    if request.at_s > state["available_until_s"]:
        raise ValueError("that time has not been simulated")
    if request.at_s >= config.horizon_s:
        raise ValueError("the simulation horizon has ended")
    total = config.initial_population
    temperature = config.temperature_c
    assigned: set[str] = set()
    closed: set[str] = set()
    for command in state["commands"]:
        if command["at_s"] > request.at_s:
            continue
        change = command["intervention"]
        if change["kind"] == "population":
            total += change["count"]
        elif change["kind"] == "temperature":
            temperature = change["temperature_c"]
        elif change["kind"] == "add_bus_route":
            assigned.add(change["bus_id"])
        elif change["kind"] == "reopen_road":
            closed.difference_update(change["edge_ids"])
        elif change["kind"] == "close_road" and (change["until_s"] is None or change["until_s"] > request.at_s):
            closed.update(change["edge_ids"])
    value = request.intervention
    out = {"at_s": request.at_s, "branches_history": request.at_s < state["time_s"], "assumption": "Synthetic demand and explicit mobility assumptions; outcomes are measured by SUMO.", "intervention": value.model_dump()}
    if isinstance(value, IncidentChange):
        profile = HAZARDS[value.hazard]
        x, y = net.convertLonLat2XY(value.lon, value.lat)
        edges = LiveNetwork(net, None, (0.0, 0.0)).edges_within(x, y, value.radius_m)
        if not edges:
            raise ValueError("no streets lie inside that footprint; place the incident on the city")
        out.update(
            title=f"{value.label or profile.label}: {value.radius_m} m footprint", detail=profile.description,
            edges=len(edges), alarm_radius_m=value.alarm_radius_m, duration_s=value.effective_duration_s, blocks=list(profile.blocks),
            assumption=f"Travelers within {value.alarm_radius_m:g} m witness it; others learn only from neighbours within earshot. Responses are measured, not scripted.",
        )
    elif isinstance(value, TemperatureChange):
        response = temperature_response(value.temperature_c)
        out.update(title=f"Temperature {temperature:g} to {value.temperature_c:g} C", detail="Adjust walking speed and tolerance, then reconsider available transit. Road friction is unchanged.", mobility=response.model_dump(), assumption=response.assumption)
    elif isinstance(value, PopulationChange):
        zones = {z.zone_id: z for z in pack.zones}
        if value.destination_zone_id not in zones or (value.origin_zone_id and value.origin_zone_id not in zones):
            raise ValueError("select a known origin and destination district")
        if total + value.count > MAX_TRAVELERS:
            raise ValueError(f"this would exceed {MAX_TRAVELERS} travelers in one session")
        if request.at_s + value.release_window_s >= config.horizon_s:
            raise ValueError("release window must finish before the horizon")
        out.update(title=f"Send {value.count:,} travelers to {zones[value.destination_zone_id].name}", detail=f"Add individually simulated journeys over {value.release_window_s} seconds. Existing travelers remain intact.", cohort_after=total + value.count)
    elif isinstance(value, RoadChange):
        for eid in value.edge_ids:
            try:
                edge = net.getEdge(eid)
            except KeyError:
                raise ValueError(f"unknown road {eid}") from None
            if edge.isSpecial() or not (edge.allows("bus") or edge.allows("passenger")):
                raise ValueError("select a vehicle street, not a sidewalk or junction")
        out.update(title=f"{'Close' if value.kind == 'close_road' else 'Reopen'} {len(set(value.edge_ids))} road segments", detail="Preserve sidewalks and original lane permissions. Vehicles without a detour remain accounted for.")
    elif isinstance(value, BusRouteChange):
        fleet = [f"bus_{chr(65 + i)}" if i < 26 else f"bus_{i + 1}" for i in range(config.fleet_size)]
        if value.bus_id not in fleet or value.bus_id in assigned:
            raise ValueError("select an unassigned vehicle from the finite fleet")
        stops = {s.stop_id: s for s in pack.stops}
        if any(sid not in stops for sid in value.stop_ids) or len(set(value.stop_ids)) != len(value.stop_ids):
            raise ValueError("choose distinct known bus stops")
        sequence = [stops[sid] for sid in value.stop_ids]
        for a, b in pairwise([*sequence, sequence[0]]):
            if a.edge_id in closed or b.edge_id in closed or not a.allowed or not b.allowed:
                raise ValueError("a selected stop is unavailable or on a closed road")
            path, _ = route(net, a.edge_id, b.edge_id, "bus", closed, from_lane=a.lane_index)
            if not path:
                raise ValueError(f"no bus route from {a.name} to {b.name}")
        out.update(title=f"Assign {value.bus_id.replace('_', ' ')} to a shuttle route", detail="60 seats, one persistent physical vehicle, repeated pickup and drop-off visits.", stop_names=[s.name for s in sequence])
    elif isinstance(value, DevelopmentChange):
        spec = value.spec
        access = resolve_access(net, pack, spec)
        counts = trip_counts(spec)
        if total + counts["added_trips"] > MAX_TRAVELERS:
            raise ValueError(f"this would exceed {MAX_TRAVELERS} travelers in one session")
        if request.at_s + spec.first_wave.start_s >= config.horizon_s - 1:
            raise ValueError("the building's first trips would start after the simulation horizon")
        arriving, leaving = counts["inbound_trips"], counts["outbound_trips"]
        what = " and ".join(part for part in [f"{leaving:,} leaving" if leaving else "", f"{arriving:,} arriving" if arriving else ""] if part)
        out.update(
            title=f"Place {spec.name}: {counts['added_trips']:,} one-way trips", detail=f"{what}, individually simulated from the moment it is placed. Existing travelers remain intact.",
            assumption=f"{spec.capacity:,} {'homes' if spec.land_use == 'residential' else 'people'} · {round(spec.car_share * 100)}% by car, the rest walk or ride. Declared assumptions, not a forecast.",
            cohort_after=total + counts["added_trips"], access=[a.model_dump(mode="json") for a in access], **counts,
        )
    elif isinstance(value, RemoveDevelopmentChange):
        standing = {d["development_id"]: d for d in state.get("developments", [])}
        if value.development_id not in standing:
            raise ValueError("no such development stands in this city")
        name = standing[value.development_id]["spec"]["name"]
        out.update(title=f"Demolish {name}", detail="Travelers who have not set off yet are dropped; those already on their way finish their trips.", assumption="Demolition changes future demand only; the street network is untouched.")
    return out
