import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from cityshift_swarm.contracts import ResidentDecision


@pytest.mark.parametrize("tokens", [1_000_001, 20_000_000])
def test_actual_main_client_transmits_exact_declared_budget_to_local_admission_double(tmp_path, monkeypatch, tokens):
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "backend"))
    from cityshift.agents import population_client
    from cityshift.contracts import BrainAssignment, PopulationBudget, PopulationSpec, ResidentProfile

    brain = BrainAssignment(model_family="test-double", model_id="test-local-model", api_provider="local",
                            config_ref="local-wire-contract-test", control_mode="jiuwenswarm")
    population = SimpleNamespace(
        spec=PopulationSpec(count=5, brains=[brain], budget=PopulationBudget(max_tokens=tokens, max_iterations=6)),
        profiles=[ResidentProfile(resident_id=f"test-resident-{index}", name="Synthetic resident",
                                  persona="Local admission-double fixture.", roles=["customer"], preferences={},
                                  home_anchor_id="test-home", household_id="test-household",
                                  available_classes=["pedestrian"])
                  for index in range(5)],
        assignments={f"test-resident-{index}": brain for index in range(5)},
    )
    project = tmp_path / "local-client-fixture"
    python = project / ".venv" / "bin" / "python"
    python.parent.mkdir(parents=True)
    python.touch()
    monkeypatch.setattr(population_client, "SWARM_ROOT", project)
    admitted = []
    processes = []

    class ProcessTestDouble:
        def __init__(self, command, *, cwd, env, stdout, stderr):
            assert command == [str(python), "-m", "cityshift_swarm.app"]
            assert cwd == project
            assert "OPENROUTER_API_KEY" not in env
            self.returncode = None
            processes.append(self)

        def poll(self):
            return self.returncode

        def terminate(self):
            self.returncode = 0

        def wait(self, timeout=None):
            return self.returncode

    def local_admission_double(request):
        assert request.url.host == "127.0.0.1"
        if request.url.path == "/health":
            return httpx.Response(200, json={"verified": True, "native_available": True, "max_residents": 20,
                                            "test_double": True, "model_execution_verified": False})
        if request.url.path == "/runs":
            admitted.append(json.loads(request.content))
            return httpx.Response(201, json={"run_id": "local-wire-test", "generation": 0})
        assert request.url.path == "/runs/local-wire-test/stop"
        return httpx.Response(200, json={"status": "stopped"})

    original_client = httpx.Client

    def local_http_client(**kwargs):
        return original_client(transport=httpx.MockTransport(local_admission_double), **kwargs)

    monkeypatch.setattr(population_client.subprocess, "Popen", ProcessTestDouble)
    monkeypatch.setattr(population_client.httpx, "Client", local_http_client)
    client = population_client.NativePopulationClient(
        "local-wire-test", population, "test-controller-" + "a" * 32, "test-gateway-" + "b" * 32,
        "http://127.0.0.1:9876/v1", "http://127.0.0.1:9877",
    )
    try:
        client.start()
        assert len(admitted) == 1
        assert admitted[0]["budget"]["max_tokens"] == population.spec.budget.max_tokens == tokens
        assert admitted[0]["budget"]["max_iterations"] == 6
        instructions = admitted[0]["residents"][0]["instructions"]
        assert "Do not call observe_local_state or view_tasks solely to reread" in instructions
        assert "actual visible task_id, never an anchor_id" in instructions
        assert "proposal as a nested JSON object" in instructions
        example = instructions.split("Format-only structured_output example: ", 1)[1]
        value = json.JSONDecoder().raw_decode(example)[0]
        assert ResidentDecision.model_validate(value).proposal.action == "wait"
        assert "not an action recommendation" in instructions
    finally:
        client.close()
    assert not client.active and client._process is None and client._http is None
    assert processes and all(process.poll() == 0 for process in processes)
