from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field, model_validator

from cityshift.contracts import DevelopmentSpec

MAX_TRAVELERS = 10000
Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")]
Temperature = Annotated[float, Field(ge=-40, le=50, allow_inf_nan=False)]


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class SessionConfig(InputModel):
    pack_id: Identifier
    seed: int = Field(default=7, ge=0, le=2147483647, strict=True)
    horizon_s: int = Field(default=3600, ge=300, le=14400, strict=True)
    initial_population: int = Field(default=600, ge=0, le=MAX_TRAVELERS, strict=True)
    fleet_size: int = Field(default=2, ge=0, le=32, strict=True)
    temperature_c: Temperature = 20
    car_share: float = Field(default=0.35, ge=0, le=1)


class RoadChange(InputModel):
    kind: Literal["close_road", "reopen_road"]
    edge_ids: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(min_length=1, max_length=256)
    until_s: int | None = Field(default=None, ge=1, le=14400, strict=True)


class BusRouteChange(InputModel):
    kind: Literal["add_bus_route"]
    bus_id: Identifier
    stop_ids: list[Annotated[str, Field(min_length=1, max_length=160)]] = Field(min_length=2, max_length=8)


class TemperatureChange(InputModel):
    kind: Literal["temperature"]
    temperature_c: Temperature


class PopulationChange(InputModel):
    kind: Literal["population"]
    count: int = Field(ge=1, le=MAX_TRAVELERS, strict=True)
    destination_zone_id: Identifier
    origin_zone_id: Identifier | None = None
    release_window_s: int = Field(default=300, ge=0, le=1800, strict=True)


@dataclass(frozen=True)
class HazardProfile:
    label: str
    blocks: tuple[str, ...]
    alarm_factor: float
    default_duration_s: int
    description: str


EVERYONE = ("passenger", "bus", "pedestrian")
HAZARDS: dict[str, HazardProfile] = {
    "crash": HazardProfile("Vehicle collision", ("passenger", "bus"), 2.5, 900, "Streets inside the footprint close to cars and buses. Sidewalks stay open."),
    "fire": HazardProfile("Building fire", EVERYONE, 3.0, 1800, "Nobody may enter the footprint. People inside leave for the nearest street outside it."),
    "flood": HazardProfile("Flash flood", EVERYONE, 2.0, 3600, "Streets and sidewalks inside the footprint are impassable until the water recedes."),
    "tornado": HazardProfile("Tornado", EVERYONE, 4.0, 600, "A wide warning radius: everyone who sees it leaves the footprint and spreads the word."),
    "gas_leak": HazardProfile("Gas leak", EVERYONE, 3.0, 1200, "The footprint is evacuated and closed to all traffic."),
}
Hazard = Literal["crash", "fire", "flood", "tornado", "gas_leak"]


class IncidentChange(InputModel):
    kind: Literal["incident"]
    hazard: Hazard
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    radius_m: int = Field(default=120, ge=20, le=1500, strict=True)
    duration_s: int | None = Field(default=None, ge=30, le=14400, strict=True)
    label: Annotated[str, Field(min_length=1, max_length=60, pattern=r"^[A-Za-z0-9 ,.'()/&-]+$")] | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def effective_duration_s(self) -> int:
        return self.duration_s if self.duration_s is not None else HAZARDS[self.hazard].default_duration_s

    @computed_field  # type: ignore[prop-decorator]
    @property
    def alarm_radius_m(self) -> float:
        return round(self.radius_m * HAZARDS[self.hazard].alarm_factor, 1)


class DevelopmentChange(InputModel):
    """Place a building in the running city: its declared trips are generated from the placement and inserted live."""

    kind: Literal["development"]
    spec: DevelopmentSpec


class RemoveDevelopmentChange(InputModel):
    """Demolish a placed development: travelers who have not set off yet are dropped, the rest finish their trips."""

    kind: Literal["remove_development"]
    development_id: Identifier


Intervention = Annotated[
    RoadChange | BusRouteChange | TemperatureChange | PopulationChange | IncidentChange | DevelopmentChange | RemoveDevelopmentChange,
    Field(discriminator="kind"),
]


class InterventionRequest(InputModel):
    command_id: Identifier
    at_s: int = Field(ge=0, le=14400, strict=True)
    expected_revision: int = Field(ge=0, strict=True)
    intervention: Intervention

    @model_validator(mode="after")
    def validate_window(self):
        change = self.intervention
        if isinstance(change, RoadChange) and change.until_s is not None and change.until_s <= self.at_s:
            raise ValueError("closure end must be after the playhead")
        return self


class AdvanceRequest(InputModel):
    target_s: int = Field(ge=0, le=14400, strict=True)


class TemperatureResponse(BaseModel):
    model_version: str = "cold-mobility-v1"
    walk_speed_factor: float
    walk_tolerance_factor: float
    road_speed_factor: float = 1
    assumption: str = "Illustrative cold response, not calibrated weather or an ice forecast."


def temperature_response(temperature_c: float) -> TemperatureResponse:
    if not math.isfinite(temperature_c) or not -40 <= temperature_c <= 50:
        raise ValueError("temperature must be between -40 and 50 Celsius")
    cold = max(0.0, (20 - temperature_c) / 20)
    return TemperatureResponse(
        walk_speed_factor=max(0.65, 1 - cold * 0.1),
        walk_tolerance_factor=max(0.25, 1 - cold * 0.25),
    )
