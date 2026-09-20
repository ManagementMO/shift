from swarmflow import agent, agent_session

META = {"name": "sdk_failure_patch_probe"}
SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}


async def run(args):
    mode = args["mode"]
    if mode.startswith("single"):
        prompt = "fail-single" if mode == "single" else "success-single"
        return await agent(prompt, label="one")
    if mode in {"schema", "repair", "timeout", "cancel", "abort", "legacy_null"}:
        session = agent_session(label="one", options={"timeout": 0.001} if mode == "timeout" else None)
        schema = SCHEMA if mode in {"schema", "repair"} else None
        return await session.send(mode, schema=schema)
    first = agent_session(label="first")
    second = agent_session(label="second")
    results = []
    for epoch in range(3 if args.get("extend") else 2):
        prompt = f"fail-{epoch}" if mode == "stateful" and epoch < 2 else f"success-first-{epoch}"
        results.append(await first.send(prompt))
        results.append(await second.send(f"success-second-{epoch}"))
    return results
