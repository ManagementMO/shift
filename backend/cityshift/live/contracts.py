from __future__ import annotations

import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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


Intervention = Annotated[RoadChange | BusRouteChange | TemperatureChange | PopulationChange, Field(discriminator="kind")]


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
