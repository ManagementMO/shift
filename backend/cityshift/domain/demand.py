"""Synthetic venue-egress cohort.  Every attribute is a declared scenario input, never inferred."""

from __future__ import annotations

import math
import random
from typing import Literal

from cityshift.contracts import CityPack, DemandSet, Development, DevelopmentSpec, Traveler, content_hash


def generate_demand(
    pack: CityPack,
    seed: int,
    cohort_size: int = 240,
    egress_window_s: tuple[int, int] = (0, 900),
    car_share: float = 0.35,
    walk_limits_m: tuple[tuple[int, float], ...] = ((800, 0.3), (1500, 0.45), (2500, 0.25)),
    background_vehicles: int = 150,
) -> DemandSet:
    rng = random.Random(seed)
    zone_ids = [z.zone_id for z in pack.zones]
    weights = [z.share for z in pack.zones]
    limits = [w for w, _ in walk_limits_m]
    lweights = [p for _, p in walk_limits_m]
    travelers: list[Traveler] = []
    for i in range(cohort_size):
        zone = rng.choices(zone_ids, weights)[0]
        z = next(z for z in pack.zones if z.zone_id == zone)
        travelers.append(
            Traveler(
                person_id=f"p{i:04d}",
                origin_edge=pack.venue_edge_id,
                dest_edge=rng.choice(z.edge_ids),
                dest_zone=zone,
                depart_s=int(rng.triangular(egress_window_s[0], egress_window_s[1], egress_window_s[0] + (egress_window_s[1] - egress_window_s[0]) * 0.3)),
                has_car=rng.random() < car_share,
                walk_limit_m=rng.choices(limits, lweights)[0],
            )
        )
    travelers.sort(key=lambda t: t.depart_s)
    identity = content_hash({
        "generator": "venue-egress-v2", "pack": pack.pack_id, "network": pack.network_fingerprint,
        "venue": pack.venue_edge_id, "zones": [z.model_dump(mode="json") for z in pack.zones],
        "seed": seed, "cohort_size": cohort_size, "egress_window_s": egress_window_s,
        "car_share": car_share, "walk_limits_m": walk_limits_m, "background_vehicles": background_vehicles,
    })
    return DemandSet(
        demand_id=f"{pack.pack_id}-egress-{identity}",
        seed=seed,
        travelers=travelers,
        background_vehicles=background_vehicles,
        synthetic=True,
        generation_method=(
            f"synthetic-venue-egress: {cohort_size} travelers, zone shares declared in pack, "
            f"car share {car_share}, walk limits {dict(walk_limits_m)}, triangular egress over {egress_window_s}s"
        ),
    )


def development_participants(spec: DevelopmentSpec) -> int:
    return math.floor(spec.capacity * spec.people_per_unit * spec.trip_rate + 0.5)


def development_travelers(development: Development) -> list[Traveler]:
    spec = development.spec
    rng = random.Random(spec.seed)
    count = development_participants(spec)
    car_ids = set(rng.sample(range(count), math.floor(count * spec.car_share + 0.5)))
    zone_ids = sorted(z for z, share in spec.zone_shares.items() if share > 0)
    weights = [spec.zone_shares[z] for z in zone_ids]
    access = {a.mode: a for a in development.access}
    first: Literal["outbound", "inbound"] = "outbound" if spec.land_use == "residential" else "inbound"
    reverse: Literal["outbound", "inbound"] = "inbound" if first == "outbound" else "outbound"
    waves = [(first, spec.first_wave)]
    if spec.return_wave:
        waves.append((reverse, spec.return_wave))
    travelers = []
    for i in range(count):
        has_car = i in car_ids
        anchor = access["passenger" if has_car else "pedestrian"]
        zone = rng.choices(zone_ids, weights)[0]
        other = rng.choice(anchor.zone_edges[zone])
        for direction, wave in waves:
            depart = (rng.uniform(wave.start_s, wave.end_s) if wave.profile == "uniform"
                      else rng.triangular(wave.start_s, wave.end_s, (wave.start_s + wave.end_s) / 2))
            outbound = direction == "outbound"
            travelers.append(Traveler(
                person_id=f"{development.development_id}-{i:05d}-{direction}",
                origin_edge=anchor.edge_id if outbound else other,
                dest_edge=other if outbound else anchor.edge_id,
                dest_zone=zone if outbound else development.development_id,
                depart_s=min(wave.end_s - 1, int(depart)), has_car=has_car, walk_limit_m=spec.walk_limit_m,
                development_id=development.development_id, trip_direction=direction,
            ))
    return sorted(travelers, key=lambda t: (t.depart_s, t.person_id))


def append_development_demand(parent: DemandSet, development: Development) -> DemandSet:
    added = development_travelers(development)
    incumbent_ids = {t.person_id for t in parent.travelers}
    if any(t.person_id in incumbent_ids for t in added):
        raise ValueError("development trips already exist in this demand")
    identity = content_hash({
        "generator": "development-v1", "parent": content_hash(parent),
        "development": development.model_dump(mode="json"),
    })
    return DemandSet(
        demand_id=f"demand-{identity}", seed=parent.seed,
        travelers=[t.model_copy(deep=True) for t in parent.travelers] + added,
        background_vehicles=parent.background_vehicles, synthetic=True,
        generation_method=f"{parent.generation_method}; {development.development_id}: {len(added)} synthetic one-way trips",
    )
