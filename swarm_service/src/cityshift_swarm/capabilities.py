from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from openjiuwen.core.foundation.tool import Tool, ToolCard
from openjiuwen.core.single_agent.rail.base import AgentCallbackEvent, AgentRail
from openjiuwen.harness.manifest import ElementKind, harness_element, register_from_catalog
from openjiuwen.harness.rails.security.base_security_rail import BaseSecurityRail

from cityshift_swarm.bridge import BridgeFailure
from cityshift_swarm.contracts import CITY_TOOLS, TOOL_ARGUMENTS
from cityshift_swarm.control import CONTEXT_KEY, NativeUnavailable, RunControl
from cityshift_swarm.prepare import attest_core_patch
from cityshift_swarm.settings import GATEWAY_CREDENTIAL_REF

CITY_PROVIDER = "cityshift.population.tools.v1"
BOUNDARY_PROVIDER = "cityshift.population.boundary.v1"
IDENTITY_PROVIDER = "cityshift.population.identity.v1"


def control_from(context: Any) -> RunControl:
    control = context.extras.get(CONTEXT_KEY)
    if not isinstance(control, RunControl) or context.team_id != control.team_id:
        raise NativeUnavailable("missing_trusted_population_context")
    return control


def validate_model(model: Any, control: RunControl, expected: str, *, probe_only: bool = False) -> str:
    if model is None:
        raise NativeUnavailable("missing_native_model")
    client = model.model_client_config
    request = getattr(model, "model_config", None)
    resolved = getattr(request, "model_name", None) or getattr(client, "model_name", None)
    if (
        resolved != expected
        or client.api_base.rstrip("/") != control.settings.gateway_url
        or client.api_key != (GATEWAY_CREDENTIAL_REF if probe_only else control.settings.gateway_token)
        or client.verify_ssl is not True
        or str(client.client_provider) not in {"OpenAI", "ProviderType.OpenAI"}
    ):
        raise NativeUnavailable("native_model_resolution_mismatch")
    return resolved


def hydrate_model(config: Any, control: RunControl, model_id: str) -> Any:
    if config is None or config.model_client_config.api_key != GATEWAY_CREDENTIAL_REF:
        raise NativeUnavailable("native_credential_reference_missing")
    hydrated = config.model_copy(update={
        "model_client_config": config.model_client_config.model_copy(update={
            "api_key": control.settings.gateway_token,
        }),
    })
    validate_model(SimpleNamespace(
        model_config=hydrated.model_request_config, model_client_config=hydrated.model_client_config,
    ), control, model_id)
    return hydrated


class CityTool(Tool):
    def __init__(self, name: str, control: RunControl, resident_id: str):
        super().__init__(ToolCard(
            id=name,
            name=name,
            description=f"Actor-scoped city bridge operation: {name}. Proposals are not committed actions.",
            input_params=TOOL_ARGUMENTS[name].model_json_schema(),
            parallel_safe=False,
            stateless=False,
            idempotent=True,
        ))
        self.control = control
        self.resident_id = resident_id

    async def invoke(self, inputs: dict[str, Any], **kwargs: Any) -> Any:
        scope = self.control.active_scope(self.resident_id)
        return await self.control.bridge.call(scope, self.card.name, inputs)

    async def stream(self, inputs: dict[str, Any], **kwargs: Any):
        yield await self.invoke(inputs)


class IdentityRail(AgentRail):
    priority = -999

    def __init__(self, context: Any):
        super().__init__()
        self.context = context
        self.control = control_from(context)
        self.resident_id = None
        if str(context.role) in {"worker", "teammate"}:
            self.resident_id = self.control.resident_for_context(context)

    def init(self, agent: Any) -> None:
        if self.resident_id is None:
            self.control.attach_leader(self.context)
            return
        present = {card.name for card in agent.ability_manager.list()}
        if not CITY_TOOLS.issubset(present):
            self.control.fail("essential_city_tools_missing")
            raise NativeUnavailable("essential_city_tools_missing")
        resolved = validate_model(
            self.context.extras.get("_parent_model"), self.control,
            self.control.roster[self.resident_id].model_id,
            probe_only=str(self.context.role) == "teammate",
        )
        if str(self.context.role) == "teammate":
            self.control.named_agents[self.resident_id] = agent
        self.control.bindings[self.resident_id].resolved_model_id = resolved
        self.control.persist()

    async def before_invoke(self, ctx: Any) -> None:
        if self.resident_id is not None:
            self.control.record_session(self.resident_id, ctx.session)

    async def after_model_call(self, ctx: Any) -> None:
        if self.resident_id is not None:
            self.control.record_usage(self.resident_id, getattr(ctx.inputs, "response", None))

    async def on_model_exception(self, ctx: Any) -> None:
        if self.resident_id is not None and self.resident_id in self.control.usage:
            self.control.usage[self.resident_id].usage_missing = True


class PopulationBoundaryRail(BaseSecurityRail):
    priority = -1000
    supported_events = {AgentCallbackEvent.BEFORE_MODEL_CALL, AgentCallbackEvent.BEFORE_TOOL_CALL}

    def __init__(self, context: Any):
        super().__init__()
        self.context = context
        self.control = control_from(context)
        self.resident_id = None
        if str(context.role) in {"worker", "teammate"}:
            self.resident_id = self.control.resident_for_context(context)
        elif str(context.role) != "leader":
            raise NativeUnavailable("unapproved_native_role")

    async def run_security_check(self, security_ctx: Any) -> Any:
        try:
            return await self._check(security_ctx)
        except Exception:
            self.control.fail("population_capability_boundary_failed")
            return self.reject("population_capability_boundary_failed")

    async def _check(self, security_ctx: Any) -> Any:
        attest_core_patch()
        ctx = security_ctx.callback_ctx
        if self.resident_id is None:
            return self.reject("leader_inference_and_model_authored_workflows_disabled")
        allowed = CITY_TOOLS | {"structured_output"}
        if security_ctx.event is AgentCallbackEvent.BEFORE_TOOL_CALL:
            if ctx.inputs.tool_name not in allowed:
                return self.reject("population_capability_denied")
            try:
                self.control.active_scope(self.resident_id)
            except BridgeFailure:
                return self.reject("inactive_population_epoch")
            return self.allow()
        if str(self.context.role) == "teammate":
            return self.reject("named_capability_probe_inference_disabled")
        if ctx.has_force_finish_request:
            return self.allow()
        tools = [tool for tool in (ctx.inputs.tools or []) if getattr(tool, "name", None) in allowed]
        ctx.inputs.tools = tools
        if {tool.name for tool in tools} != allowed:
            self.control.fail("essential_city_tools_missing")
            return self.reject("essential_city_tools_missing")
        try:
            scope = self.control.active_scope(self.resident_id)
            await self.control.bridge.bind(scope)
            if not self.control.record_model_call(self.resident_id):
                return self.reject("iteration_budget_exhausted")
        except BridgeFailure:
            self.control.fallbacks[self.resident_id] = "city_bridge_unavailable"
            return self.reject("city_bridge_unavailable")
        return self.allow()


@harness_element(kind=ElementKind.TOOL, name=CITY_PROVIDER, description="Trusted actor-bound city tools")
def build_city_tools(params: dict[str, Any], context: Any) -> list[Tool]:
    if params:
        raise NativeUnavailable("city_provider_has_no_model_parameters")
    control = control_from(context)
    resident_id = control.resident_for_context(context)
    control.attach_worker(context)
    return [CityTool(name, control, resident_id) for name in sorted(CITY_TOOLS)]


@harness_element(kind=ElementKind.RAIL, name=BOUNDARY_PROVIDER, description="Population capability ceiling")
def build_population_boundary(params: dict[str, Any], context: Any) -> PopulationBoundaryRail:
    if params:
        raise NativeUnavailable("boundary_has_no_parameters")
    return PopulationBoundaryRail(context)


@harness_element(kind=ElementKind.RAIL, name=IDENTITY_PROVIDER, description="Native identity and usage binding")
def build_identity_rail(params: dict[str, Any], context: Any) -> IdentityRail:
    if params:
        raise NativeUnavailable("identity_has_no_parameters")
    return IdentityRail(context)


def register_capabilities() -> None:
    register_from_catalog()
