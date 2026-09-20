"""Domain contracts (Section 20 of the brief). Pydantic models shared by compiler, worker, API, agents."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

SCHEMA_VERSION = "0.2"


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
    scenario_kind: Literal["transport", "population"] = "transport"
    population_id: str | None = None
    evidence_bundle_id: str | None = None
    evidence_hash: str | None = None
    restrictions: list[Restriction] = []
    hazards: list[HazardTrack] = []
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
    paused = "paused"
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
    kind: Literal["bus", "car", "person", "bicycle", "delivery", "truck"]
    samples: list[list[float]] = Field(description="[t, lon, lat, angle, speed] rows")
    breaks: list[int] = Field(default_factory=list, description="sample indices where the trail must break")
    resident_id: str | None = None
    vehicle_class: str | None = None


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
    run_kind: Literal["transport", "population"] = "transport"
    population_id: str | None = None
    checkpoint_id: str | None = None
    checkpoint_available: bool = False
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


class Investigation(BaseModel):
    """One agent investigation: problem + constraint text -> frozen evidence -> proposed, validated plans."""

    investigation_id: str
    scenario_id: str
    problem_text: str
    constraint_text: str
    status: Literal["queued", "running", "completed", "failed"] = "queued"
    engine: str = "openjiuwen-react"
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


TravelClass = Literal["pedestrian", "bicycle", "passenger", "delivery", "truck"]
TRAVEL_CLASSES: tuple[TravelClass, ...] = ("pedestrian", "bicycle", "passenger", "delivery", "truck")
PopulationAction = Literal[
    "request_service", "accept", "decline", "travel", "prepare", "pickup", "deliver",
    "visit", "serve", "report_delay", "message", "wait", "rest", "revise_commitment",
]


class PopulationContract(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, allow_inf_nan=False)


class ActionProposal(PopulationContract):
    action: PopulationAction
    target_id: str | None = Field(default=None, max_length=160)
    travel_class: TravelClass | None = None
    request_kind: Literal["delivery", "visit"] | None = None
    duration_s: int = Field(default=30, ge=1, le=3600)
    text: str = Field(default="", max_length=600)
    idempotency_key: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_.:-]+$")
    observation_refs: list[str] = Field(default_factory=list, max_length=32)


class ActionIntent(ActionProposal):
    run_id: str
    resident_id: str
    epoch: int = Field(ge=0)
    world_version: int = Field(ge=0)
    effective_t: int = Field(ge=0)
    expires_t: int = Field(ge=0)

    @model_validator(mode="after")
    def valid_window(self) -> ActionIntent:
        if self.expires_t < self.effective_t:
            raise ValueError("intent expires before its effective time")
        return self


class ResidentDecision(PopulationContract):
    proposal: ActionProposal
    summary: str = Field(min_length=1, max_length=600)
    plan: list[str] = Field(default_factory=list, max_length=6)
    beliefs: list[str] = Field(default_factory=list, max_length=6)


ResidentRole = Literal["customer", "shop_worker", "service_worker", "courier", "driver"]
MobilityMode = Literal["stationary", "walk", "cycle", "drive", "transit"]


class BrainAssignment(PopulationContract):
    model_family: str = Field(min_length=1, max_length=60)
    model_id: str = Field(min_length=1, max_length=160)
    api_provider: str = Field(min_length=1, max_length=60)
    config_ref: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_.-]+$")
    control_mode: Literal["jiuwenswarm", "rules"] = "jiuwenswarm"
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class PopulationBudget(PopulationContract):
    max_concurrency: int = Field(default=4, ge=1, le=16)
    max_iterations: int = Field(default=4, ge=1, le=8)
    decision_timeout_s: int = Field(default=60, ge=1, le=180)
    max_calls: int = Field(default=2400, ge=0, le=10000)
    max_tokens: int = Field(default=20_000_000, ge=0, le=20_000_000)
    max_output_tokens: int = Field(default=1024, ge=128, le=2048)
    max_cost_usd: float = Field(default=20, ge=0, le=20)
    requests_per_minute: int = Field(default=60, ge=1, le=120)
    tokens_per_minute: int = Field(default=5_000_000, ge=1, le=20_000_000)


class AnchorAccess(PopulationContract):
    edge_id: str
    position_m: float = Field(ge=0)
    lane_index: int = Field(default=0, ge=0)


class ActivityAnchor(PopulationContract):
    anchor_id: str
    name: str
    purpose: Literal["home", "shop", "service", "work", "rest"]
    lon: float = Field(ge=-180, le=180)
    lat: float = Field(ge=-90, le=90)
    access: dict[TravelClass, AnchorAccess]
    capacity: int = Field(default=1, ge=1, le=1000)
    opens_s: int = Field(default=0, ge=0)
    closes_s: int = Field(default=86400, ge=1)
    service_duration_s: int = Field(default=60, ge=1, le=3600)
    synthetic: Literal[True] = True

    @model_validator(mode="after")
    def valid_access(self) -> ActivityAnchor:
        if "pedestrian" not in self.access or self.opens_s >= self.closes_s:
            raise ValueError("anchor needs pedestrian access and a valid availability window")
        return self


class RoutineStep(PopulationContract):
    activity: Literal["work", "errand", "rest", "home"]
    anchor_id: str
    earliest_s: int = Field(ge=0)
    duration_s: int = Field(ge=1)


class ResidentProfile(PopulationContract):
    resident_id: str
    name: str
    persona: str
    roles: list[ResidentRole] = Field(min_length=1)
    preferences: dict[str, float | str]
    home_anchor_id: str
    work_anchor_id: str | None = None
    contacts: list[str] = Field(default_factory=list)
    household_id: str
    organization_id: str | None = None
    available_classes: list[TravelClass] = Field(min_length=1)
    carrying_capacity: int = Field(default=1, ge=1, le=100)
    routine: list[RoutineStep] = Field(default_factory=list)
    synthetic: Literal[True] = True


class MemoryEntry(PopulationContract):
    event_id: str
    t: int = Field(ge=0)
    kind: Literal["observation", "outcome", "message", "belief"]
    text: str = Field(max_length=600)
    related_residents: list[str] = Field(default_factory=list)


class ResidentState(PopulationContract):
    resident_id: str
    role: ResidentRole
    activity: Literal["idle", "traveling", "working", "preparing", "serving", "waiting", "resting"] = "idle"
    anchor_id: str | None
    destination_id: str | None = None
    mobility_mode: MobilityMode = "stationary"
    travel_class: TravelClass | None = None
    needs: dict[str, float] = Field(default_factory=dict)
    commitments: list[str] = Field(default_factory=list)
    current_task_id: str | None = None
    plan: list[str] = Field(default_factory=list)
    beliefs: list[str] = Field(default_factory=list)
    memories: list[MemoryEntry] = Field(default_factory=list)
    relationships: dict[str, float] = Field(default_factory=dict)
    vehicle_locations: dict[TravelClass, str] = Field(default_factory=dict)
    busy_until_s: int = Field(default=0, ge=0)
    next_decision_s: int = Field(default=0, ge=0)
    next_need_s: int = Field(default=900, ge=1)
    last_decision_s: int | None = None
    fallback_reason: str | None = None
    version: int = Field(default=0, ge=0)


class SocietyTask(PopulationContract):
    task_id: str
    kind: Literal["delivery", "visit"]
    requester_id: str
    service_anchor_id: str
    destination_anchor_id: str
    status: Literal[
        "requested", "accepted", "preparing", "ready", "assigned", "picked_up", "serving",
        "completed", "declined", "failed", "expired",
    ] = "requested"
    provider_id: str | None = None
    assignee_id: str | None = None
    required_capacity: int = Field(default=1, ge=1)
    created_s: int = Field(ge=0)
    deadline_s: int = Field(ge=1)
    ready_s: int | None = None
    completed_s: int | None = None
    failure_reason: str | None = None
    declined_by: list[str] = Field(default_factory=list)
    version: int = Field(default=0, ge=0)
    cause_id: str | None = None


class PopulationSpec(PopulationContract):
    generator_version: Literal["society-v1"] = "society-v1"
    rules_version: Literal["service-ledger-v1"] = "service-ledger-v1"
    pack_id: str = Field(default="toronto", pattern=r"^[a-zA-Z0-9_-]+$")
    seed: int = 7
    count: int = Field(default=12, ge=5, le=300)
    horizon_s: int = Field(default=3600, ge=60, le=14400)
    enabled_classes: list[TravelClass] = Field(
        default_factory=lambda: list(TRAVEL_CLASSES), min_length=1,
    )
    brains: list[BrainAssignment] = Field(min_length=1, max_length=12)
    budget: PopulationBudget = Field(default_factory=PopulationBudget)
    recurring_need_s: int = Field(default=900, ge=120, le=7200)
    service_duration_s: int = Field(default=60, ge=10, le=1800)
    decision_interval_s: int = Field(default=30, ge=5, le=120)
    district_radius_m: float = Field(default=700, ge=100, le=2000)

    @model_validator(mode="after")
    def valid_classes(self) -> PopulationSpec:
        if "pedestrian" not in self.enabled_classes:
            raise ValueError("population requires pedestrian access")
        if len(set(self.enabled_classes)) != len(self.enabled_classes):
            raise ValueError("duplicate enabled travel class")
        if len({b.config_ref for b in self.brains}) != len(self.brains):
            raise ValueError("brain config references must be unique")
        modes = {b.control_mode for b in self.brains}
        if len(modes) != 1:
            raise ValueError("rules fixtures and native cognition must be separate runs")
        return self


class PopulationDefinition(PopulationContract):
    population_id: str
    spec: PopulationSpec
    network_fingerprint: str
    anchors: list[ActivityAnchor]
    profiles: list[ResidentProfile]
    initial_states: list[ResidentState]
    initial_tasks: list[SocietyTask]
    assignments: dict[str, BrainAssignment]
    assumptions: list[str] = Field(default_factory=list)


class MobilityBinding(PopulationContract):
    resident_id: str
    entity_id: str | None
    mode: MobilityMode
    vehicle_class: str | None = None
    anchor_id: str | None = None
    start_s: int = Field(ge=0)
    end_s: int | None = Field(default=None, ge=0)
    ownership: Literal["resident", "shared", "abstract"] = "resident"
    measured: bool = True
    capacity: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def valid_interval(self) -> MobilityBinding:
        if self.end_s is not None and self.end_s < self.start_s:
            raise ValueError("mobility interval ends before it starts")
        if self.mode == "stationary" and (self.measured or self.anchor_id is None):
            raise ValueError("stationary presence must be explicitly abstract at an anchor")
        return self


class SwarmBinding(PopulationContract):
    resident_id: str
    run_id: str
    team_id: str
    workflow_id: str
    session_id: str
    worker_id: str
    requested_model_id: str
    resolved_model_id: str
    bound_s: int = Field(default=0, ge=0)
    generation: int = Field(default=0, ge=0)
    restored: bool = False


class PopulationEvent(PopulationContract):
    event_id: str
    t: int = Field(ge=0)
    epoch: int = Field(ge=0)
    kind: str
    resident_ids: list[str]
    task_id: str | None = None
    cause_id: str | None = None
    text: str = Field(max_length=600)
    status: Literal["proposed", "committed", "observed"] = "committed"


class SocialMessage(PopulationContract):
    message_id: str
    sender_id: str
    recipient_id: str
    sent_s: int = Field(ge=0)
    delivered_s: int | None = None
    text: str = Field(max_length=600)
    task_id: str | None = None
    cause_id: str | None = None


class PopulationDecisionRecord(PopulationContract):
    decision_id: str
    resident_id: str
    t: int = Field(ge=0)
    epoch: int = Field(ge=0)
    source: Literal["jiuwenswarm", "rules", "fallback"]
    assigned_model_id: str
    actual_model_id: str | None = None
    summary: str = Field(max_length=600)
    proposal: ActionIntent | None = None
    accepted: bool = False
    reason: str = ""
    plan: list[str] = Field(default_factory=list)
    beliefs: list[str] = Field(default_factory=list)
    outcome_event_ids: list[str] = Field(default_factory=list)
    fallback_reason: str | None = None
    latency_ms: int = Field(default=0, ge=0)
    usage: dict[str, int | float | str] = Field(default_factory=dict)


class ResidentSnapshot(PopulationContract):
    t: int = Field(ge=0)
    state: ResidentState


class TaskSnapshot(PopulationContract):
    t: int = Field(ge=0)
    task: SocietyTask


class PopulationMetrics(PopulationContract):
    version: Literal["population-1"] = "population-1"
    resident_count: int
    horizon_s: int
    end_time_s: int
    task_status_counts: dict[str, int]
    completed_deliveries: int = 0
    completed_visits: int = 0
    outstanding_needs: int = 0
    outstanding_commitments: int = 0
    accepted_actions: int = 0
    rejected_actions: int = 0
    decision_source_counts: dict[str, int] = Field(default_factory=dict)
    memory_entries: int = 0
    delivered_messages: int = 0
    completed_trips: int = 0
    failed_trips: int = 0
    calls: int = 0
    tokens: int = 0
    cost_usd: float = 0
    reserved_cost_usd: float = 0
    artifact_bytes: int = 0
    wall_time_s: float = 0
    warnings: list[str] = Field(default_factory=list)


class PopulationArtifact(PopulationContract):
    version: Literal["population-1"] = "population-1"
    run_id: str
    attempt_id: str
    definition: PopulationDefinition
    states: list[ResidentSnapshot]
    tasks: list[TaskSnapshot]
    decisions: list[PopulationDecisionRecord]
    messages: list[SocialMessage]
    events: list[PopulationEvent]
    mobility_bindings: list[MobilityBinding]
    swarm_bindings: list[SwarmBinding]
    metrics: PopulationMetrics
