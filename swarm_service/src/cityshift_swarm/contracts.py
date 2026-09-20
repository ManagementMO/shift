from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_RESIDENTS = 100

Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")]
TravelClass = Literal["pedestrian", "bicycle", "passenger", "delivery", "truck"]
PopulationAction = Literal[
    "request_service", "accept", "decline", "travel", "prepare", "pickup", "deliver",
    "visit", "serve", "report_delay", "message", "wait", "rest", "revise_commitment",
]
CITY_TOOLS = frozenset({
    "observe_local_state", "recall_experience", "view_tasks", "estimate_trip", "propose_action",
    "propose_message",
})


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, allow_inf_nan=False, strict=True)


class ActionProposal(Contract):
    action: PopulationAction = Field(description=(
        "One eligible city action name, not a function call or Python expression."
    ))
    target_id: str | None = Field(default=None, max_length=160, description=(
        "Use a visible anchor_id for travel/request_service; an actual visible task_id for "
        "accept/decline/prepare/pickup/deliver/visit/serve/report_delay/revise_commitment; "
        "a known contact's resident_id for message. Omit for wait/rest. Never invent an ID."
    ))
    travel_class: TravelClass | None = Field(default=None, description=(
        "A travel class available to this resident at the current anchor, respecting vehicle ownership."
    ))
    request_kind: Literal["delivery", "visit"] | None = None
    duration_s: int = Field(default=30, ge=1, le=3600)
    text: str = Field(default="", max_length=600)
    idempotency_key: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_.:-]+$")
    observation_refs: list[str] = Field(default_factory=list, max_length=32)


class ResidentDecision(Contract):
    proposal: ActionProposal = Field(description=(
        "A nested JSON object with action fields, exactly matching the actor's propose_action submission. "
        "Never a quoted string, Python constructor, or function-call text. This example shows format only."
    ), examples=[{"action": "wait", "duration_s": 30, "idempotency_key": "fresh-epoch-key"}])
    summary: str = Field(min_length=1, max_length=600, description=(
        "A brief simulated decision summary, not hidden internal reasoning or an invented outcome."
    ))
    plan: list[str] = Field(default_factory=list, max_length=6)
    beliefs: list[str] = Field(default_factory=list, max_length=6)


class EmptyArguments(Contract):
    pass


class EstimateArguments(Contract):
    target_id: str | None = Field(default=None, max_length=160)
    travel_class: TravelClass | None = None


class MessageArguments(Contract):
    target_id: str = Field(min_length=1, max_length=160)
    text: str = Field(min_length=1, max_length=600)
    idempotency_key: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_.:-]+$")
    observation_refs: list[str] = Field(default_factory=list, max_length=32)


TOOL_ARGUMENTS = {
    "observe_local_state": EmptyArguments,
    "recall_experience": EmptyArguments,
    "view_tasks": EmptyArguments,
    "estimate_trip": EstimateArguments,
    "propose_action": ActionProposal,
    "propose_message": MessageArguments,
}


class Resident(Contract):
    resident_id: Identifier
    instructions: str = Field(min_length=1, max_length=6000)
    model_id: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_./:-]+$")


class ModelEndpoint(Contract):
    model_id: str = Field(min_length=1, max_length=160, pattern=r"^[a-zA-Z0-9_./:-]+$")
    api_base: str = Field(min_length=1, max_length=300)
    api_key_env: Literal["CITYSHIFT_SWARM_GATEWAY_TOKEN"]


class Budget(Contract):
    max_concurrency: int = Field(ge=1, le=20)
    max_iterations: int = Field(ge=1, le=12)
    decision_timeout_s: int = Field(ge=1, le=120)
    max_tokens: int = Field(ge=1, le=20_000_000)


Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
CheckpointId = Annotated[str, Field(pattern=r"^cp_[a-f0-9]{32}$")]


class CheckpointBoundary(Contract):
    epoch: int = Field(ge=0)
    t: int = Field(ge=0)
    world_version: int = Field(ge=0)
    world_state_hash: Digest


class ResumeBoundary(CheckpointBoundary):
    checkpoint_hash: Digest


class CheckpointResponse(CheckpointBoundary):
    run_id: str
    checkpoint_id: CheckpointId
    checkpoint_hash: Digest
    generation: int
    native_tokens_spent: int


class RunRequest(Contract):
    run_id: Identifier
    residents: list[Resident] = Field(min_length=1, max_length=MAX_RESIDENTS)
    models: list[ModelEndpoint] = Field(min_length=1, max_length=8)
    budget: Budget
    city_bridge_url: str = Field(min_length=1, max_length=300)
    resume_checkpoint: CheckpointId | None = None
    resume_boundary: ResumeBoundary | None = None

    @model_validator(mode="after")
    def validate_roster(self) -> RunRequest:
        if (self.resume_checkpoint is None) != (self.resume_boundary is None):
            raise ValueError("resume_checkpoint and resume_boundary must be supplied together")
        resident_ids = [r.resident_id for r in self.residents]
        model_ids = [m.model_id for m in self.models]
        if len(set(resident_ids)) != len(resident_ids) or len(set(model_ids)) != len(model_ids):
            raise ValueError("duplicate resident or model")
        if any(r.model_id not in model_ids for r in self.residents):
            raise ValueError("unknown model assignment")
        return self


class DecisionRequest(Contract):
    epoch: int = Field(ge=0)
    t: int = Field(ge=0)
    world_version: int = Field(ge=0)
    observations: list[dict[str, Any]] = Field(max_length=20)

    @model_validator(mode="after")
    def validate_packets(self) -> DecisionRequest:
        seen = set()
        for packet in self.observations:
            resident_id = packet.get("resident_id")
            if not isinstance(resident_id, str) or resident_id in seen:
                raise ValueError("invalid observation resident")
            seen.add(resident_id)
            for key in ("epoch", "t", "world_version"):
                if type(packet.get(key)) is not int or packet[key] != getattr(self, key):
                    raise ValueError("observation epoch/time/version mismatch")
            if len(json.dumps(packet, allow_nan=False).encode()) > 65536:
                raise ValueError("observation exceeds 64 KiB")
        return self


class Binding(Contract):
    team_id: str
    workflow_id: str
    session_id: str | None = None
    worker_id: str | None = None
    requested_model_id: str
    resolved_model_id: str | None = None


class Usage(Contract):
    model_calls: int = 0
    reported_model_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    usage_missing: bool = False
    latency_ms: int = 0


class DecisionRow(Contract):
    resident_id: str
    decision: ResidentDecision | None = None
    binding: Binding
    fallback_reason: str | None = None
    usage: Usage = Field(default_factory=Usage)


class DecisionResponse(Contract):
    run_id: str
    epoch: int
    runtime_status: Literal["running", "failed", "stopped"]
    decisions: list[DecisionRow]
    native_tokens_spent: int = 0
    generation: int = 0
