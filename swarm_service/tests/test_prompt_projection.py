import json
from copy import deepcopy
from pathlib import Path

import pytest
import yaml
from projection_packets import large_actor_packet

from cityshift_swarm.contracts import RunRequest
from cityshift_swarm.control import model_observation
from cityshift_swarm.settings import Settings


def test_projection_is_private_nonmutating_and_prioritizes_real_commitments():
    original = large_actor_packet("resident-a", 2)
    saved = deepcopy(original)
    visible = model_observation(original)
    assert original == saved
    assert set(visible) == set(original)
    assert visible["memories"] == original["memories"][-8:]
    assert visible["messages"] == original["messages"][-4:]
    assert visible["tasks"] == [original["tasks"][index] for index in (30, 31, 28, 0, 1, 2, 3, 4)]
    assert visible["state"] == original["state"]
    assert visible["profile"] == original["profile"]
    assert visible["trip_options"] == original["trip_options"]
    assert len(json.dumps(visible)) < len(json.dumps(original)) / 2
    visible["state"]["commitments"].clear()
    visible["memories"][0]["text"] = "modified test view"
    assert original == saved


def test_projection_keeps_every_visible_commitment_even_over_eight():
    original = large_actor_packet("resident-a", 2)
    original["state"]["commitments"] = [task["task_id"] for task in original["tasks"][-12:]]
    visible = model_observation(original)
    assert visible["tasks"] == original["tasks"][-12:]
    assert set(original["state"]["commitments"]) == {task["task_id"] for task in visible["tasks"]}
    assert visible["state"]["current_task_id"] in {task["task_id"] for task in visible["tasks"]}
    assert len(original["tasks"]) == 32


def test_projection_accepts_small_and_partial_observations_without_fabricating_data():
    packet = {"resident_id": "resident-a", "epoch": 0, "memories": ["private-one"], "tasks": []}
    assert model_observation(packet) == packet
    assert model_observation({"resident_id": "resident-a"}) == {"resident_id": "resident-a"}


@pytest.mark.parametrize("output_ceiling", [256, 1024])
def test_output_ceiling_is_selected_and_price_reserved_by_actual_gateway(tmp_path, monkeypatch, output_ceiling):
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "backend"))
    from cityshift.agents.population_gateway import RunLimits, RunScope, _normalize_request

    root = tmp_path / "native-config"
    config_dir = root / "native" / "config"
    config_dir.mkdir(parents=True)
    settings = Settings(root=root, gateway_url="http://127.0.0.1:9876/v1",
                        city_bridge_url="http://127.0.0.1:9877",
                        control_token="test-controller-" + "a" * 32, gateway_token="test-gateway-" + "b" * 32)
    request = RunRequest.model_validate({
        "run_id": "projection-unit", "residents": [{"resident_id": "resident-a", "instructions": "Local fixture.",
                                                    "model_id": "openai/gpt-4.1-mini"}],
        "models": [{"model_id": "openai/gpt-4.1-mini", "api_base": settings.gateway_url,
                    "api_key_env": "CITYSHIFT_SWARM_GATEWAY_TOKEN"}],
        "budget": {"max_tokens": 20_000_000, "max_concurrency": 1, "max_iterations": 6, "decision_timeout_s": 30},
        "city_bridge_url": settings.city_bridge_url,
    })
    settings.write_native_config(request)
    config = yaml.safe_load((config_dir / "config.yaml").read_text())
    model = config["models"]["defaults"][0]
    assert "max_tokens" not in model["model_config_obj"]
    scope = RunScope(run_hash="local-fixture", token_hash="local-fixture-token",
                     model_ids=("openai/gpt-4.1-mini",), allowed_tools=frozenset(),
                     limits=RunLimits(max_output_tokens=output_ceiling))
    body = {"model": "openai/gpt-4.1-mini", "messages": [{"role": "user", "content": "Local unit fixture."}]}
    sent, quote = _normalize_request(scope, body)
    assert sent["max_tokens"] == quote.output_tokens == output_ceiling
    assert quote.ceiling_microdollars > 0
    _, smaller = _normalize_request(scope, body | {"max_tokens": 128})
    assert quote.ceiling_microdollars > smaller.ceiling_microdollars
