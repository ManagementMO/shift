import asyncio
import json
import os
import sys
from pathlib import Path

from aiohttp import web
from failed_checkpoint_process import FAILURES
from local_gateway_double import LocalGatewayAndBridgeTestDouble


async def test_native_failed_first_and_repeated_turns_checkpoint_restart(tmp_path):
    double = LocalGatewayAndBridgeTestDouble()
    double.auto_epochs = True
    double.require_tool_history = True
    double.failed_turns = FAILURES
    double.malformed_proposal_turns = {("person-0", 0)}
    app = web.Application()
    app.router.add_post("/v1/chat/completions", double.completion)
    app.router.add_post("/api/population/bridge/{run_id}/bind", double.bind)
    app.router.add_post("/api/population/bridge/{run_id}/tool", double.tool)
    server = web.AppRunner(app)
    await server.setup()
    site = web.TCPSite(server, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    root = tmp_path / "failed-native-turns"
    script = Path(__file__).with_name("failed_checkpoint_process.py")
    baseline = os.environ.get("CITYSHIFT_PATCH_BASELINE_PROBE") == "1"
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TMPDIR") if key in os.environ}
    phases = ("baseline",) if baseline else ("first", "second")
    try:
        for phase in phases:
            process = await asyncio.create_subprocess_exec(
                sys.executable, str(script), str(root), phase, f"http://127.0.0.1:{port}",
                env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            try:
                async with asyncio.timeout(90):
                    output, error = await process.communicate()
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            assert process.returncode == 0, (output.decode() + error.decode())[-14000:]
            if phase in {"first", "baseline"}:
                assert len(double.calls) == 46
                assert len(double.staged) == 17
        if baseline:
            assert json.loads((root / "baseline.json").read_text())["reproduced_409"] is True
        else:
            first = json.loads((root / "first.json").read_text())
            second = json.loads((root / "second.json").read_text())
            assert first["pid"] != second["pid"]
            assert len(double.calls) == 86
            assert len(double.staged) == 37
            assert all(epoch >= 2 for _, epoch, _, _ in double.calls[46:])
            assert second["tokens"] == 1720
            journal = root / "checkpoints" / first["checkpoint"]["checkpoint_id"] / "journal.jsonl.wal"
            records = [json.loads(line) for line in journal.read_text().splitlines() if line]
            failures = [record["stateful_failure"]["error"] for record in records if "stateful_failure" in record]
            assert any("proposal" in error and "input_type=str" in error for error in failures)
            assert any("did not submit a structured result" in error for error in failures)
            assert all((resident, epoch) not in FAILURES for resident, epoch, _ in double.staged)
    finally:
        await server.cleanup()
