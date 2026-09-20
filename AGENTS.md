# Project verification

- Backend environment: Python 3.12, `.venv`; preserve `openjiuwen==0.1.18` for the existing transit analysts. JiuwenSwarm requires a separate pinned environment.
- From `backend`: `../.venv/bin/pytest -q`, `../.venv/bin/ruff check cityshift tests`, `../.venv/bin/mypy cityshift`.
- The existing Waterloo integration tests skip when `var/citypacks/waterloo/pack.json` is absent. SUMO comes from the `eclipse-sumo` wheel, not Homebrew.
- From `frontend`: `npm ci --legacy-peer-deps` matches the existing lockfile; plain `npm ci` tries to resolve absent optional peer trees. Then `npm test`, `npm run lint`, and `npm run build` (includes TypeScript checking).
- Keep native JiuwenSwarm integration, deterministic city authority, and replay-only inspection distinct. Mock/rules tests do not prove live model execution.
- Do not add detailed life animations, event/consequence swarms, model rankings, or a new renderer on the population branch.
- Never print or commit environment credentials. Model verification needs an explicitly approved budget; the approved total for this implementation session is $20.
- The operator explicitly approved the existing non-renewing $40 OpenRouter key cap with BYOK excluded. `CITYSHIFT_POPULATION_APPROVED_40_KEY=1` opts into that provider policy; the persistent application session cap remains $20, and BYOK usage/billing is still unsupported. Without this opt-in, the original $20/BYOK-inclusive key policy remains enforced.
- Population backend startup for this approved session: `CITYSHIFT_POPULATION_LIVE=1 CITYSHIFT_POPULATION_APPROVED_40_KEY=1 .venv/bin/uvicorn cityshift.api.app:app --host 127.0.0.1 --port 8000` from the workspace root. Do not reset the persistent budget ledger between runs.
- Native SDK verification: from `swarm_service`, `.venv/bin/python -m pytest -q`, `.venv/bin/ruff check src tests`, and `.venv/bin/python -m cityshift_swarm.prepare --check`. Native visible context uses two SDK rounds while private checkpoint history remains durable.
- Population replay publications are cumulative every 300 simulated seconds and on every final/pause/failure boundary; all underlying movement samples and state transitions are retained.
