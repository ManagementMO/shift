import asyncio
import socket

import pytest

from cityshift_swarm.contracts import RunRequest
from cityshift_swarm.native import NativeHost, installed_sources
from cityshift_swarm.settings import Settings


def request_for(settings, run_id="assembly-one"):
    return RunRequest.model_validate({
        "run_id": run_id,
        "residents": [
            {"resident_id": "resident-a", "instructions": "Keep Alice's experience private.", "model_id": "alpha"},
            {"resident_id": "resident-b", "instructions": "Keep Bob's experience private.", "model_id": "beta"},
        ],
        "models": [
            {"model_id": name, "api_base": settings.gateway_url, "api_key_env": "CITYSHIFT_SWARM_GATEWAY_TOKEN"}
            for name in ("alpha", "beta")
        ],
        "budget": {"max_concurrency": 2, "max_iterations": 3, "decision_timeout_s": 10, "max_tokens": 4000},
        "city_bridge_url": settings.city_bridge_url,
    })


@pytest.mark.asyncio
async def test_native_assembly_and_turns_with_local_test_doubles(tmp_path, monkeypatch):
    settings = Settings(
        root=tmp_path / "native-isolation",
        gateway_url="http://127.0.0.1:9876/v1",
        city_bridge_url="http://127.0.0.1:9877",
        control_token="test-controller-" + "a" * 32,
        gateway_token="test-gateway-" + "b" * 32,
    )
    settings.isolate_environment()
    settings.write_native_config()
    monkeypatch.chdir(settings.root)
    attempts = []

    def forbidden_network(sock, address):
        attempts.append(address)
        raise AssertionError("No network or inference is permitted in the native assembly test")

    original_connect = socket.socket.connect
    monkeypatch.setattr(socket.socket, "connect", forbidden_network)
    from cityshift_swarm.prepare import prepare_core

    prepare_core()
    from jiuwenswarm.agents.harness.team.team_manager import TeamManager
    from openjiuwen.agent_teams.workflow.backends.team_worker_backend import TeamWorkerBackend
    from openjiuwen.core.runner import Runner

    from cityshift_swarm.capabilities import register_capabilities

    register_capabilities()
    assert TeamManager is not None
    assert installed_sources()["verified"]
    host = NativeHost(settings)
    await host.initialize()
    if host.startup_error is not None:
        raise host.startup_error
    assert host.available, host.error
    try:
        result = await host.start(request_for(settings))
        run = host.runs["assembly-one"]
        control = run.control
        assert result["status"] == "running"
        assert result["model_execution_verified"] is False
        assert type(control.context).__name__ == "SwarmBuildContext"
        assert isinstance(control.backend, TeamWorkerBackend)
        assert any(entry.team_name == control.team_id for entry in await Runner.list_active_teams())
        workers = []
        for label, resident in control.labels.items():
            worker = await control.backend.open_session(
                kind="agent", instructions=resident.instructions,
                opts={"label": label, "model": resident.model_id},
            )
            workers.append(worker)
        manager = control.backend._sessions()
        avatars = [manager._sessions[worker].harness for worker in workers]
        assert avatars[0].get_deep_agent() is not avatars[1].get_deep_agent()
        for avatar, resident in zip(avatars, control.request.residents, strict=True):
            native = avatar.get_deep_agent()
            context_config = native._react_agent.config.context_engine_config
            assert context_config.default_window_round_num == 2
            assert context_config.default_window_message_num is None
            assert context_config.max_context_message_num is None
            assert context_config.tokenizer_offline
            assert not context_config.enable_tokenizer_download
            assert not context_config.enable_openrouter_model_context_window_tokens
            names = {card.name for card in native.ability_manager.list()}
            assert {
                "observe_local_state", "recall_experience", "view_tasks", "estimate_trip",
                "propose_action", "propose_message",
            }.issubset(names)
            assert avatar.sys_operation is None
            rail_types = {type(rail).__name__ for rail in native.configured_rails()}
            assert not {"SafetyPromptRail", "PopulationBoundaryRail", "TeamPermissionRail"} - rail_types
            assert "ContextProcessorRail" not in rail_types
            assert control.bindings[resident.resident_id].resolved_model_id == resident.model_id
        assert avatars[0].current_session().get_session_id() != avatars[1].current_session().get_session_id()
        assert attempts == []
        assert control.native_budget.spent == 0
        await host.stop("assembly-one")
        assert run.cleaned
        assert manager._sessions == {}
        assert not await Runner.list_active_teams()
        await host.start(request_for(settings, "assembly-two"))
        assert host.runs["assembly-two"].control.team_id != control.team_id
        from named_teammate_probe import probe_named_native_teammate

        await probe_named_native_teammate(host.runs["assembly-two"].control)
        assert attempts == []
        await host.stop("assembly-two")
        assert not await Runner.list_active_teams()
        from local_gateway_double import exercise_local_gateway_test_double

        await host.close()
        await exercise_local_gateway_test_double(settings, monkeypatch, original_connect)
    finally:
        await host.close()
        await asyncio.sleep(0)
