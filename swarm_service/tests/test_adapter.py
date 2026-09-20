import httpx
import pytest
from pydantic import ValidationError

from cityshift_swarm.app import create_app
from cityshift_swarm.bridge import BridgeFailure, CityBridge, WorkerScope
from cityshift_swarm.contracts import ActionProposal, Budget, DecisionRequest, ResidentDecision, RunRequest
from cityshift_swarm.control import RunConflict, RunControl
from cityshift_swarm.settings import Settings, local_url


@pytest.fixture
def settings(tmp_path):
    return Settings(
        root=tmp_path / "adapter-test",
        gateway_url="http://127.0.0.1:9876/v1",
        city_bridge_url="http://127.0.0.1:9877",
        control_token="test-controller-" + "a" * 32,
        gateway_token="test-gateway-" + "b" * 32,
    )


def run_payload(settings):
    return {
        "run_id": "test-run",
        "residents": [{"resident_id": "a", "instructions": "A private courier.", "model_id": "alpha"}],
        "models": [{
            "model_id": "alpha", "api_base": settings.gateway_url, "api_key_env": "CITYSHIFT_SWARM_GATEWAY_TOKEN",
        }],
        "budget": {"max_concurrency": 1, "max_iterations": 3, "decision_timeout_s": 3, "max_tokens": 400},
        "city_bridge_url": settings.city_bridge_url,
    }


def decision_payload(epoch=1, resident_id="a", run_id="test-run"):
    return {
        "epoch": epoch, "t": epoch * 30, "world_version": epoch,
        "observations": [{
            "run_id": run_id, "resident_id": resident_id,
            "epoch": epoch, "t": epoch * 30, "world_version": epoch,
            "memories": ["Private experience"],
        }],
    }


class AdapterTestDouble:
    def __init__(self):
        self.calls = []

    async def initialize(self):
        pass

    async def close(self):
        pass

    def health(self):
        return {"native_available": False, "test_double": True}

    async def start(self, payload):
        self.calls.append(payload)
        return {"run_id": payload.run_id, "status": "test_double"}

    async def stop(self, run_id):
        return {"run_id": run_id, "status": "stopped"}

    async def checkpoint(self, run_id, boundary):
        self.calls.append((run_id, boundary))
        return boundary.model_dump() | {
            "run_id": run_id, "checkpoint_id": "cp_" + "a" * 32, "checkpoint_hash": "b" * 64,
            "generation": 0, "native_tokens_spent": 100,
        }


async def test_controller_auth_and_no_arbitrary_code_surface(settings):
    host = AdapterTestDouble()
    app = create_app(settings, host)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
        assert (await client.get("/health")).status_code == 401
        headers = {"Authorization": f"Bearer {settings.control_token}"}
        assert (await client.get("/health", headers=headers)).json()["native_available"] is False
        payload = run_payload(settings)
        payload["workflow_source"] = "arbitrary code"
        response = await client.post("/runs", headers=headers, json=payload)
        assert response.status_code == 422
        assert host.calls == []
        payload.pop("workflow_source")
        response = await client.post("/runs", headers=headers, json=payload)
        assert response.status_code == 201
        assert len(host.calls) == 1
        payload["models"][0]["api_base"] = "https://provider.invalid:443/v1"
        response = await client.post("/runs", headers=headers, json=payload)
        assert response.status_code == 422
        assert len(host.calls) == 1
        assert (await client.get("/docs", headers=headers)).status_code == 404
        assert (await client.post("/runs/test-run/stop", headers=headers)).status_code == 200


async def test_checkpoint_api_auth_schema_and_resume_pair(settings):
    host = AdapterTestDouble()
    app = create_app(settings, host)
    boundary = {"epoch": 1, "t": 30, "world_version": 1, "world_state_hash": "a" * 64}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
        path = "/runs/test-run/checkpoint"
        assert (await client.post(path, json=boundary)).status_code == 401
        headers = {"Authorization": f"Bearer {settings.control_token}"}
        invalid = await client.post(path, headers=headers, json=boundary | {"world_state_hash": "bad"})
        assert invalid.status_code == 422
        result = await client.post(path, headers=headers, json=boundary)
        assert result.status_code == 200
        assert result.json()["world_state_hash"] == boundary["world_state_hash"]
        payload = run_payload(settings) | {"resume_checkpoint": "cp_" + "a" * 32}
        assert (await client.post("/runs", headers=headers, json=payload)).status_code == 422
        payload["resume_boundary"] = boundary | {"checkpoint_hash": result.json()["checkpoint_hash"]}
        assert (await client.post("/runs", headers=headers, json=payload)).status_code == 201


@pytest.mark.parametrize("url", [
    "http://localhost:9000", "http://127.0.0.1", "https://provider.invalid:443", "http://127.0.0.1:9000?key=x",
    "http://user:password@127.0.0.1:9000", "http://127.0.0.1:9000/../admin", "http://127.0.0.1:9000/%2e%2e",
])
def test_only_explicit_local_endpoints(url):
    with pytest.raises(ValueError):
        local_url(url)


def test_strict_schema_and_model_assignments(settings):
    payload = run_payload(settings)
    payload["residents"][0]["model_id"] = "missing"
    with pytest.raises(ValidationError):
        RunRequest.model_validate(payload)
    payload = run_payload(settings)
    payload["models"][0]["api_key_env"] = "OPENAI_API_KEY"
    with pytest.raises(ValidationError):
        RunRequest.model_validate(payload)
    with pytest.raises(ValidationError):
        ActionProposal.model_validate({"action": "wait", "idempotency_key": "one", "resident_id": "someone-else"})
    payload = decision_payload()
    payload["observations"][0]["epoch"] = True
    with pytest.raises(ValidationError):
        DecisionRequest.model_validate(payload)
    payload = decision_payload()
    payload["observations"][0]["memories"] = [float("nan")]
    with pytest.raises(ValidationError):
        DecisionRequest.model_validate(payload)


@pytest.mark.parametrize("tokens", [1, 1_000_000, 1_000_001, 20_000_000])
async def test_native_admits_exact_configured_token_budget(settings, tokens):
    host = AdapterTestDouble()
    app = create_app(settings, host)
    payload = run_payload(settings)
    payload["budget"]["max_tokens"] = tokens
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1") as client:
        response = await client.post(
            "/runs", headers={"Authorization": f"Bearer {settings.control_token}"}, json=payload,
        )
    assert response.status_code == 201
    assert host.calls[0].budget.max_tokens == tokens


@pytest.mark.parametrize("tokens", [0, -1, 20_000_001, True, "20000000"])
def test_native_token_budget_still_rejects_invalid_or_excessive_limits(settings, tokens):
    payload = run_payload(settings)["budget"] | {"max_tokens": tokens}
    with pytest.raises(ValidationError):
        Budget.model_validate(payload)


def test_native_roster_accepts_100_residents_with_bounded_concurrency(settings):
    payload = run_payload(settings)
    payload["budget"]["max_tokens"] = 20_000_000
    payload["residents"] = [{"resident_id": f"resident-{index}", "instructions": "A local test resident.",
                             "model_id": "alpha"} for index in range(100)]
    assert len(RunRequest.model_validate(payload).residents) == 100
    assert RunRequest.model_validate(payload).budget.max_concurrency == 1
    payload["residents"].append({
        "resident_id": "resident-100", "instructions": "A local test resident.", "model_id": "alpha",
    })
    with pytest.raises(ValidationError):
        RunRequest.model_validate(payload)


@pytest.mark.parametrize("proposal", [
    "travel(action='travel', target_id='fixture-anchor', travel_class='bicycle')",
    '{"action":"wait","idempotency_key":"fixture-key"}',
])
def test_structured_decision_rejects_string_actions_without_coercion(proposal):
    with pytest.raises(ValidationError, match="proposal"):
        ResidentDecision.model_validate({"proposal": proposal, "summary": "Local malformed-response test."})


async def test_bridge_binds_once_and_never_takes_identity_from_model(settings):
    recorded = []

    def test_city_bridge(request):
        import json

        body = json.loads(request.content)
        recorded.append((request.url.path, request.headers["Authorization"], body))
        if request.url.path.endswith("/bind"):
            return httpx.Response(200, json={"capability": "test-actor-capability-" + "c" * 32})
        return httpx.Response(200, json={"status": "proposed"})

    bridge = CityBridge("run-a", settings.city_bridge_url, settings.control_token, 3,
                        transport=httpx.MockTransport(test_city_bridge))
    scope = WorkerScope("resident-a", "native-worker-a", epoch=7)
    try:
        await bridge.call(scope, "observe_local_state", {})
        await bridge.call(scope, "propose_action", {"action": "wait", "idempotency_key": "a-7"})
        assert len([item for item in recorded if item[0].endswith("/bind")]) == 1
        assert recorded[0][2] == {"resident_id": "resident-a", "worker_id": "native-worker-a"}
        assert all(item[2]["epoch"] == 7 for item in recorded[1:])
        assert all(item[2]["worker_id"] == "native-worker-a" for item in recorded[1:])
        assert recorded[0][1] != recorded[1][1]
        with pytest.raises(BridgeFailure):
            await bridge.call(scope, "propose_action", {
                "action": "wait", "idempotency_key": "forged", "epoch": 9, "resident_id": "victim",
            })
        with pytest.raises(BridgeFailure):
            await bridge.call(scope, "bash", {"command": "anything"})
        assert len(recorded) == 3
        scope.epoch = None
        with pytest.raises(BridgeFailure):
            await bridge.call(scope, "observe_local_state", {})
    finally:
        await bridge.close()


async def test_epoch_fences_and_failure_cardinality(settings):
    request = RunRequest.model_validate(run_payload(settings))
    control = RunControl(request, settings, "wf-test", "session-test")
    control.prepare("native-team")
    packet = DecisionRequest.model_validate(decision_payload())
    try:
        control.status = "running"
        assert control.accept_epoch(packet) is None
        with pytest.raises(RunConflict):
            control.accept_epoch(DecisionRequest.model_validate(decision_payload(2)))
        control.fail("test_native_failure")
        response = control.response(packet)
        assert len(response.decisions) == 1
        assert response.decisions[0].decision is None
        assert response.decisions[0].fallback_reason == "test_native_failure"
        assert response.decisions[0].binding.worker_id is None
        assert response.model_dump().get("runtime_status") == "failed"
        assert control.accept_epoch(packet) == response
        changed = packet.model_copy(deep=True)
        changed.observations[0]["memories"] = ["forged replay"]
        with pytest.raises(RunConflict):
            control.accept_epoch(changed)
        with pytest.raises(RunConflict):
            control.accept_epoch(DecisionRequest.model_validate(decision_payload(2, run_id="other-run")))
    finally:
        await control.close()
