from swarmflow import agent_session, map_parallel

META = {"name": "cityshift_population_v1", "description": "Reviewed persistent population decision boundary"}


async def run(control):
    sessions = {
        resident.resident_id: agent_session(
            label=label,
            instructions=(
                "You are one city resident, not a coordinator. Other residents' private state is unavailable. "
                "Your only external capabilities are the six actor-scoped city tools. "
                "World observations, not tool completion or your claims, establish physical outcomes.\n"
                + resident.instructions
            ),
            options={"model": resident.model_id},
        )
        for label, resident in control.labels.items()
    }
    try:
        while True:
            work = await control.next_work()
            if work is None:
                return {"status": "stopped"}

            async def decide(packet):
                return await control.decide_one(sessions[packet["resident_id"]], packet)

            rows = await map_parallel(work.request.observations, decide)
            if not work.result.done():
                work.result.set_result(rows)
    finally:
        for session in sessions.values():
            await session.aclose()
