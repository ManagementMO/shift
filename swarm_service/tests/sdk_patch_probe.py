import asyncio
import copy
import json
import logging
import os
import socket
import sys
from pathlib import Path

from cityshift_swarm.prepare import BASE_FILE_SHA256, SDK_FILE, prepare_core, sha256
from cityshift_swarm.settings import Settings


async def main():
    profile, directory = sys.argv[1], Path(sys.argv[2])
    settings = Settings(root=directory / f"environment-{profile}", gateway_url="http://127.0.0.1:9/v1",
                        city_bridge_url="http://127.0.0.1:9", control_token="test-controller-" + "a" * 32,
                        gateway_token="test-gateway-" + "b" * 32)
    settings.isolate_environment()
    os.chdir(settings.root)
    logging.disable(logging.CRITICAL)

    def network_forbidden(sock, address):
        raise AssertionError("SDK semantic test doubles must never contact a network")

    socket.socket.connect = network_forbidden
    if profile == "patched":
        prepare_core()
    from openjiuwen.agent_teams.workflow.engine import primitives
    from openjiuwen.agent_teams.workflow.engine.backends.base import AgentBackend, AgentResult
    from openjiuwen.agent_teams.workflow.engine.budget import BudgetLedger
    from openjiuwen.agent_teams.workflow.engine.errors import BackendError, WorkflowAborted, WorkflowError
    from openjiuwen.agent_teams.workflow.engine.journal import Journal
    from openjiuwen.agent_teams.workflow.engine.runner import run_workflow
    from openjiuwen.agent_teams.workflow.engine.runtime import AbortSignal

    if profile == "base":
        source = Path(primitives.__file__)
        assert "var/upstream/agent-core" in str(source)
        assert sha256(await asyncio.to_thread(source.read_bytes)) == BASE_FILE_SHA256
    else:
        assert str(Path(primitives.__file__)).endswith(SDK_FILE)

    class BackendTestDouble(AgentBackend):
        def __init__(self, abort=None):
            super().__init__()
            self.calls = []
            self.reserved = []
            self.opened = []
            self.attempts = {}
            self.entered = asyncio.Event()
            self.parked = asyncio.Event()
            self.abort = abort
            self.closed = False

        async def ensure_member_name(self, *, kind, opts):
            name = f"{opts['label']}-{len(self.reserved)}"
            self.reserved.append(name)
            return name

        async def open_session(self, *, kind, instructions, opts, fork_data=None, member_name=None):
            self.opened.append(member_name)
            return member_name

        async def send_turn(self, session_id, prompt, opts, schema_json, *, history=(), correlation_id=None):
            self.calls.append({"member": session_id, "prompt": prompt, "history": copy.deepcopy(list(history))})
            return await self.answer(prompt)

        async def run(self, prompt, opts, schema_json):
            self.calls.append({"member": "single", "prompt": prompt, "history": []})
            return await self.answer(prompt)

        async def answer(self, prompt):
            self.budget.add(7)
            self.workflow_budget.add(7)
            self.attempts[prompt] = self.attempts.get(prompt, 0) + 1
            if prompt in {"timeout", "cancel"}:
                self.entered.set()
                await self.parked.wait()
            if prompt == "abort":
                self.abort.set("stop")
            if prompt.startswith("fail") or prompt == "abort":
                raise BackendError("deliberate unit-test backend failure", tokens=7)
            if prompt in {"schema", "repair"}:
                valid = prompt == "repair" and self.attempts[prompt] == 3
                return AgentResult(text="test schema", structured={"ok": True if valid else "invalid"}, tokens=7)
            if prompt == "legacy_null":
                return AgentResult(text=None, tokens=7)
            return AgentResult(text=prompt, tokens=7)

        async def close_session(self, session_id):
            pass

        async def aclose(self):
            self.closed = True

    fixture = str(Path(__file__).with_name("sdk_failure_workflow.py"))

    async def execute(name, mode, backend, *, resume=False, extend=False, spent=0, abort=None):
        path = directory / f"{name}.jsonl"
        ledger = BudgetLedger(total=10000, spent=spent)
        workflow = BudgetLedger(total=10000)
        value = await run_workflow(
            fixture, args={"mode": mode, "extend": extend}, backend=backend,
            resume=str(path) if resume else None, journal_path=str(path),
            budget=ledger, workflow_budget=workflow, abort_event=abort, run_id=name,
        )
        journal = await Journal.load(str(path), wal_path=f"{path}.wal")
        records = [record for record in journal.prior.values() if record.get("type") not in {"pause", "seal"}]
        assert backend.closed
        return value, ledger, workflow, records

    first = BackendTestDouble()
    values, spent, workflow, records = await execute(f"stateful-{profile}", "stateful", first)
    assert values == [None, "success-second-0", None, "success-second-1"]
    assert len(first.calls) == 8 and spent.spent == workflow.spent == 56
    failures = [record for record in records if "stateful_failure" in record]
    assert len(failures) == (2 if profile == "patched" else 0)
    if failures:
        assert all(record["tokens"] == 21 for record in failures)
        assert all(record["stateful_failure"]["member_name"] == "first-0" for record in failures)
    restored = BackendTestDouble()
    values, spent, workflow, records = await execute(
        f"stateful-{profile}", "stateful", restored, resume=True, extend=True, spent=56,
    )
    assert values[-2:] == ["success-first-2", "success-second-2"]
    assert restored.reserved == first.reserved == ["first-0", "second-1"]
    assert len(restored.calls) == (2 if profile == "patched" else 8)
    assert spent.spent == (70 if profile == "patched" else 112)
    assert workflow.spent == 70
    for call in restored.calls:
        if call["member"] == "first-0":
            assert call["history"] == []
        else:
            assert all("fail-" not in str(entry) for entry in call["history"])
    single = BackendTestDouble()
    result, ledger, workflow, records = await execute(f"single-{profile}", "single", single)
    assert result is None and len(single.calls) == 3 and ledger.spent == 21 and records == [], (
        result, len(single.calls), ledger.spent, [(entry.get("kind"), entry.get("key")) for entry in records],
    )
    if profile == "base":
        await execute("legacy-success", "success", BackendTestDouble())
        await execute("legacy-null", "legacy_null", BackendTestDouble())
    else:
        for name, mode in (("legacy-success", "success"), ("legacy-null", "legacy_null")):
            legacy = BackendTestDouble()
            result, _, _, records = await execute(name, mode, legacy, resume=True)
            assert legacy.calls == []
            assert all("stateful_failure" not in record for record in records)
        for mode in ("schema", "repair"):
            backend = BackendTestDouble()
            result, ledger, workflow, records = await execute(mode, mode, backend)
            assert ledger.spent == workflow.spent == 21
            assert records[0]["tokens"] == 21
            assert (result is None) == (mode == "schema")
            replay = BackendTestDouble()
            _, ledger, workflow, _ = await execute(mode, mode, replay, resume=True, spent=21)
            assert replay.calls == [] and ledger.spent == workflow.spent == 21
        timeout = BackendTestDouble()
        result, ledger, _, records = await execute("timeout", "timeout", timeout)
        assert result is None and ledger.spent == 21 and records == []
        abort = AbortSignal()
        try:
            await execute("abort", "abort", BackendTestDouble(abort), abort=abort)
            raise AssertionError("abort was journaled as an ordinary failure")
        except WorkflowAborted:
            pass
        cancelled = BackendTestDouble()
        task = asyncio.create_task(execute("cancel", "cancel", cancelled, abort=AbortSignal()))
        await cancelled.entered.wait()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert cancelled.closed
        for name in ("abort", "cancel"):
            journal = await Journal.load(
                str(directory / f"{name}.jsonl"), wal_path=str(directory / f"{name}.jsonl.wal"),
            )
            assert not [record for record in journal.prior.values() if record.get("type") not in {"pause", "seal"}]
        path = directory / "stateful-patched.jsonl"
        entries = [json.loads(line) for line in path.read_text().splitlines()]
        for entry in entries:
            if "stateful_failure" in entry:
                entry["stateful_failure"]["member_name"] = "forged-member"
                break
        path.write_text("".join(json.dumps(entry) + "\n" for entry in entries))
        invalid = BackendTestDouble()
        try:
            await execute("stateful-patched", "stateful", invalid, resume=True, extend=True)
            raise AssertionError("forged failed-turn identity was accepted")
        except WorkflowError:
            pass
        assert invalid.calls == []
    print(json.dumps({"profile": profile, "replay_calls": len(restored.calls), "failure_records": len(failures),
                      "single_shot_unchanged": True, "legacy_compatible": profile == "patched"}))


if __name__ == "__main__":
    asyncio.run(main())
