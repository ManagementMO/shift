"""Domain contracts (Section 20 of the brief). Pydantic models shared by compiler, worker, API, agents."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import UTC, datetime
from enum import Enum
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "0.1"


def utcnow() -> datetime:
    return datetime.now(UTC)


def content_hash(obj: BaseModel | dict) -> str:
    data = obj.model_dump(mode="json") if isinstance(obj, BaseModel) else obj
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()[:16]


# ---------------------------------------------------------------- city pack


class StopCandidate(BaseModel):
    stop_id: str
    name: str
    edge_id: str
    lane_index: int = 0
    start_pos: float
    end_pos: float
    lon: float
    lat: float
    allowed: bool = True


class DestinationZone(BaseModel):
    zone_id: str
    name: str
    edge_ids: list[str]
    lon: float
    lat: float
    share: float = Field(ge=0, le=1, description="Declared demand share; scenario field, not inferred")


class CityPack(BaseModel):
    pack_id: str
    name: str
    version: str
    net_file: str
    network_fingerprint: str
    bbox: tuple[float, float, float, float] = Field(description="minlon, minlat, maxlon, maxlat")
    center: tuple[float, float]
    venue_edge_id: str
    venue_lonlat: tuple[float, float]
    stops: list[StopCandidate]
    zones: list[DestinationZone]
    limitations: list[str] = []
    real_data: bool = True


# ---------------------------------------------------------------- evidence


class EvidenceClaim(BaseModel):
    claim_id: str
    source_id: str
    claim_type: Literal["closure", "restriction", "stop_change", "cancellation", "event", "note"]
    text_span: str
    edge_ids: list[str] = []
    direction: Literal["both", "forward", "backward", "n/a"] = "both"
    effective_start_s: int | None = None
    effective_end_s: int | None = None
    status: Literal["confirmed", "pending", "superseded", "rejected"] = "pending"
    supersedes: str | None = None
    location_candidates: list[str] = []


class EvidenceBundle(BaseModel):
    bundle_id: str
    corpus_snapshot: str
    query_records: list[dict] = []
    source_ids: list[str]
    claims: list[EvidenceClaim]
    assumptions: list[str] = []
    unresolved: list[str] = []
    frozen_at: datetime = Field(default_factory=utcnow)
    content_hash: str = ""

    def freeze(self) -> EvidenceBundle:
        body = self.model_dump(exclude={"content_hash", "frozen_at"})
        body["query_records"] = [{k: v for k, v in r.items() if k != "at"} for r in body["query_records"]]
        self.content_hash = content_hash(body)
        return self


# ---------------------------------------------------------------- demand / constraints


class Traveler(BaseModel):
    person_id: str
    origin_edge: str
    dest_edge: str
    dest_zone: str
    depart_s: int
    has_car: bool = False
    walk_limit_m: int = 1500
    development_id: str | None = None
    trip_direction: Literal["outbound", "inbound"] | None = None


class DevelopmentWave(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    start_s: int = Field(ge=0, le=86400)
    end_s: int = Field(gt=0, le=86400)
    profile: Literal["uniform", "triangular"]

    @model_validator(mode="after")
    def ordered(self) -> Self:
        if self.start_s >= self.end_s:
            raise ValueError("wave start must precede its end")
        return self


class DevelopmentSpec(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=80)
    land_use: Literal["residential", "office", "school"]
    position: tuple[Annotated[float, Field(ge=-180, le=180)], Annotated[float, Field(ge=-85, le=85)]]
    footprint_m: tuple[Annotated[float, Field(gt=0, le=250)], Annotated[float, Field(gt=0, le=250)]]
    height_m: float = Field(gt=0, le=300)
    capacity: int = Field(ge=1, le=5000)
    people_per_unit: float = Field(gt=0, le=10)
    trip_rate: float = Field(gt=0, le=1)
    car_share: float = Field(ge=0, le=1)
    walk_limit_m: int = Field(ge=0, le=10000)
    zone_shares: dict[str, Annotated[float, Field(ge=0, le=1)]]
    first_wave: DevelopmentWave
    return_wave: DevelopmentWave | None = None
    seed: int = Field(default=7, ge=0, le=2147483647)

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if self.land_use != "residential" and self.people_per_unit != 1:
            raise ValueError("office capacity counts employees and school capacity counts students; people_per_unit must be 1")
        if not self.zone_shares or not math.isclose(sum(self.zone_shares.values()), 1, abs_tol=1e-6):
            raise ValueError("zone shares must sum to 1")
        if self.return_wave and self.return_wave.start_s < self.first_wave.end_s:
            raise ValueError("return/dismissal wave must start after the first wave ends")
        return self


class DevelopmentAccess(BaseModel):
    mode: Literal["passenger", "pedestrian"]
    edge_id: str
    distance_m: float
    zone_edges: dict[str, list[str]]


class Development(BaseModel):
    development_id: str
    spec: DevelopmentSpec
    access: list[DevelopmentAccess]


class DevelopmentPreview(BaseModel):
    preview_id: str
    base_scenario_id: str
    development: Development
    participants: int
    incumbent_trips: int
    added_trips: int
    inbound_trips: int
    outbound_trips: int
    car_trips: int
    warnings: list[str]


class DemandSet(BaseModel):
    demand_id: str
    seed: int
    travelers: list[Traveler]
    background_vehicles: int = 0
    synthetic: bool = True
    generation_method: str = "synthetic-venue-egress"


class FleetVehicle(BaseModel):
    vehicle_id: str
    capacity: int = 60
    depot_edge: str
    available_from_s: int = 0


class ConstraintSet(BaseModel):
    fleet: list[FleetVehicle]
    horizon_s: int
    service_window_s: tuple[int, int]
    allowed_stop_ids: list[str]
    objective: Literal["completion_by_horizon", "waiting_person_minutes"] = "completion_by_horizon"
    hard_max_fleet: int = 2


class Restriction(BaseModel):
    restriction_id: str
    edge_ids: list[str]
    start_s: int
    end_s: int
    modes: list[str] = ["passenger", "bus"]
    source_claim_id: str | None = None
    label: str = ""


class HazardTrack(BaseModel):
    track_id: str
    waypoints: list[tuple[float, float]] = Field(description="lon/lat path")
    radius_m: float
    start_s: int
    end_s: int
    modes: list[str] = ["passenger", "bus", "pedestrian"]
    label: str = "assumed storm corridor (user-defined, not a forecast)"


# ---------------------------------------------------------------- plans


class Duty(BaseModel):
    duty_id: str
    vehicle_id: str
    stop_sequence: list[str]
    depart_s: int
    layover_s: int = 60


class ServicePlan(BaseModel):
    plan_id: str
    name: str
    family: Literal["none", "direct", "split", "heuristic", "custom"]
    duties: list[Duty]
    authored_by: Literal["baseline", "heuristic", "agent", "user", "revision"] = "heuristic"
    rationale: str = ""
    assumptions: list[str] = []
    parent_plan_id: str | None = None


class ValidationIssue(BaseModel):
    code: str
    severity: Literal["hard", "soft", "unknown"]
    message: str
    refs: list[str] = []


class ValidationReport(BaseModel):
    plan_id: str
    valid: bool
    issues: list[ValidationIssue] = []
    compiled_stop_positions: dict[str, tuple[float, float]] = {}


# ---------------------------------------------------------------- scenario / runs


class ScenarioSpec(BaseModel):
    scenario_id: str
    pack_id: str
    demand_id: str
    evidence_bundle_id: str | None = None
    evidence_hash: str | None = None
    restrictions: list[Restriction] = []
    hazards: list[HazardTrack] = []
    developments: list[Development] = []
    constraints: ConstraintSet
    parent_scenario_id: str | None = None
    change_set: list[str] = []
    label: str = ""
    created_at: datetime = Field(default_factory=utcnow)


class RunStatus(str, Enum):
    draft = "draft"
    validated = "validated"
    queued = "queued"
    running = "running"
    completed = "completed"
    invalid = "invalid"
    failed = "failed"
    canceled = "canceled"


class TrajectorySample(BaseModel):
    t: int
    lon: float
    lat: float
    angle: float = 0.0
    speed: float = 0.0


class EntityTrack(BaseModel):
    entity_id: str
    kind: Literal["bus", "car", "person"]
    samples: list[list[float]] = Field(description="[t, lon, lat, angle, speed] rows")
    breaks: list[int] = Field(default_factory=list, description="sample indices where the trail must break")


class PersonEvent(BaseModel):
    t: int
    person_id: str
    event: Literal["depart", "wait_start", "board", "alight", "arrive", "unroutable"]
    vehicle_id: str | None = None
    stop_id: str | None = None


class RunMetrics(BaseModel):
    metric_version: str = "0.1"
    cohort_size: int
    horizon_s: int
    completed: int
    unfinished_waiting: int
    unfinished_riding: int
    unfinished_walking: int
    unfinished_not_departed: int
    unroutable: int
    waiting_person_minutes: float
    completed_duration_median_s: float | None
    completed_duration_p95_s: float | None
    boardings: int
    extra_fleet_ids: list[str]
    max_occupancy: dict[str, int]
    teleports: int
    warnings: list[str] = []

    def completion_rate(self) -> float:
        return self.completed / self.cohort_size if self.cohort_size else 0.0


class SimulationRun(BaseModel):
    run_id: str
    scenario_id: str
    plan_id: str
    seed: int
    status: RunStatus = RunStatus.draft
    engine_version: str = ""
    created_at: datetime = Field(default_factory=utcnow)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    progress: float = 0.0
    run_dir: str = ""
    error: str | None = None
    warnings: list[str] = []
    metrics: RunMetrics | None = None
    manifest_hash: str = ""


class AgentDecision(BaseModel):
    decision_id: str
    role: str
    action: str
    inputs_summary: str
    output_summary: str
    validation: str | None = None
    model: str
    provider: str
    timestamp: datetime = Field(default_factory=utcnow)
    tool_calls: list[dict] = []


class InvestigationOptions(BaseModel):
    ai_enabled: bool = True
    plan_variants: int = Field(default=2, ge=1, le=2)
    max_iterations: int = Field(default=6, ge=2, le=6)
    use_elasticsearch: bool = True


class Investigation(BaseModel):
    """One agent investigation: problem + constraint text -> frozen evidence -> proposed, validated plans."""

    investigation_id: str
    scenario_id: str
    problem_text: str
    constraint_text: str
    status: Literal["queued", "running", "completed", "failed"] = "queued"
    engine: str = "openjiuwen-react"
    options: InvestigationOptions = Field(default_factory=InvestigationOptions)
    evidence_bundle_id: str | None = None
    decisions: list[AgentDecision] = []
    proposed_plan_ids: list[str] = []
    rejected_plan_ids: list[str] = []
    error: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    finished_at: datetime | None = None


class InterventionProposal(BaseModel):
    proposal_id: str
    kind: Literal["close_edge", "reopen_edge", "move_stop", "set_fleet", "storm", "unsupported"]
    text: str
    edge_ids: list[str] = []
    stop_id: str | None = None
    target_stop_id: str | None = None
    fleet_count: int | None = None
    start_s: int | None = None
    end_s: int | None = None
    hazard: HazardTrack | None = None
    warnings: list[str] = []
    base_scenario_id: str
    ambiguous: bool = False
    reason: str = ""
