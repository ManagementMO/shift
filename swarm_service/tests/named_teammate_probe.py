import asyncio
import json

import httpx
from openjiuwen.agent_teams.context import reset_session_id, set_session_id
from openjiuwen.agent_teams.rails.team_context import get_team_backend
from openjiuwen.core.runner import Runner
from openjiuwen.core.single_agent import AgentCard

from cityshift_swarm.bridge import CityBridge
from cityshift_swarm.contracts import CITY_TOOLS, DecisionRequest


class ProbeRegistrySpy(dict):
    def __init__(self):
        super().__init__()
        self.ready = asyncio.Event()

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        self.ready.set()


async def probe_named_native_teammate(control):
    captured = []
    registry = ProbeRegistrySpy()
    control.named_agents = registry
    packet = {"run_id": control.request.run_id, "resident_id": "resident-a", "epoch": 0, "t": 0,
              "world_version": 0, "memories": ["named-probe-private-canary"]}

    def bridge_test_double(request):
        body = json.loads(request.content)
        captured.append(body)
        if request.url.path.endswith("/bind"):
            assert body == {"resident_id": "resident-a", "worker_id": "city_probe"}
            return httpx.Response(200, json={"capability": "named-probe-capability-" + "p" * 32})
        assert body["worker_id"] == "city_probe" and body["epoch"] == 0
        return httpx.Response(200, json=packet)

    await control.bridge.close()
    control.bridge = CityBridge(control.request.run_id, control.settings.city_bridge_url,
                                control.settings.control_token, 3, transport=httpx.MockTransport(bridge_test_double))
    control.named_members["city_probe"] = "resident-a"
    token = set_session_id(control.team_session_id)
    backend = get_team_backend(control.context)
    try:
        result = await backend.spawn_member(
            member_name="city_probe", display_name="City capability probe",
            agent_card=AgentCard(id=f"{control.team_id}_city_probe", name="city_probe"),
            desc="No-inference native named-member capability probe", prompt="",
        )
        assert result
        await backend.autostart_unstarted()
        async with asyncio.timeout(15):
            await registry.ready.wait()
        assert any(member.member_name == "city_probe" for member in await backend.list_member_roster())
        native = control.named_agents["resident-a"]
        names = {card.name for card in native.ability_manager.list()}
        assert CITY_TOOLS.issubset(names)
        rails = {type(rail).__name__ for rail in native.configured_rails()}
        assert {"SafetyPromptRail", "TeamPermissionRail", "PopulationBoundaryRail"}.issubset(rails)
        boundary = DecisionRequest(epoch=0, t=0, world_version=0, observations=[packet])
        control.accept_epoch(boundary)
        control.begin_work(boundary)
        card = native.ability_manager.get("observe_local_state")
        tool = Runner.resource_mgr.get_tool(card.id)
        assert await tool.invoke({}) == packet
        assert len(captured) == 2
        assert control.bindings["resident-a"].worker_id == "city_probe"
        assert control.native_budget.spent == 0
        await backend.shutdown_member("city_probe", force=True)
    finally:
        reset_session_id(token)
