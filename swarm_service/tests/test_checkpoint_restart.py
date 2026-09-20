import asyncio
import json
import os
import sys
from pathlib import Path

from aiohttp import web
from local_gateway_double import LocalGatewayAndBridgeTestDouble


async def test_real_process_restart_uses_native_private_checkpoints_with_local_doubles(tmp_path):
    double = LocalGatewayAndBridgeTestDouble()
    double.auto_epochs = True
    double.require_tool_history = True
    app = web.Application()
    app.router.add_post("/v1/chat/completions", double.completion)
    app.router.add_post("/api/population/bridge/{run_id}/bind", double.bind)
    app.router.add_post("/api/population/bridge/{run_id}/tool", double.tool)
    server = web.AppRunner(app)
    await server.setup()
    site = web.TCPSite(server, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    root = tmp_path / "checkpoint-processes"
    script = Path(__file__).with_name("checkpoint_process.py")
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL", "TMPDIR") if name in os.environ}
    try:
        for phase in ("first", "second"):
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
            if phase == "first":
                assert len(double.calls) == 40
                assert len(double.staged) == 20
                assert len(double.capabilities) == 10
        first = json.loads((root / "first.json").read_text())
        second = json.loads((root / "second.json").read_text())
        assert first["pid"] != second["pid"]
        assert len(double.calls) == 60
        assert len(double.staged) == 30
        assert len(double.capabilities) == 20
        assert all(epoch == 3 for _, epoch, _, _ in double.calls[40:])
        assert all("test-gateway-first-" in header for header in double.authorizations[:40])
        assert all("test-gateway-second-" in header for header in double.authorizations[40:])
        assert second["response"]["native_tokens_spent"] == first["checkpoint"]["native_tokens_spent"] + 400
    finally:
        await server.cleanup()
