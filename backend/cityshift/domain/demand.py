"""Synthetic venue-egress cohort.  Every attribute is a declared scenario input, never inferred."""

from __future__ import annotations

import random

from cityshift.contracts import CityPack, DemandSet, Traveler


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
    return DemandSet(
        demand_id=f"{pack.pack_id}-egress-{cohort_size}-s{seed}",
        seed=seed,
        travelers=travelers,
        background_vehicles=background_vehicles,
        synthetic=True,
        generation_method=(
            f"synthetic-venue-egress: {cohort_size} travelers, zone shares declared in pack, "
            f"car share {car_share}, walk limits {dict(walk_limits_m)}, triangular egress over {egress_window_s}s"
        ),
    )
