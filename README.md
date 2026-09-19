# CITY//SHIFT

Give the city a problem and a resource constraint. Watch agents test possible responses.

CITY//SHIFT is a transportation scenario laboratory: a city problem (a concert letting out
during a road closure) plus a fixed resource limit (two extra buses, one operating window)
becomes a set of candidate service plans, each compiled into a real SUMO simulation and
measured on the same cohort of travelers.  Agents propose; deterministic validators reject
infeasible plans; SUMO decides what actually happens; the UI replays the recorded truth.

```
frontend/   React + TypeScript + Vite; full-screen Mapbox GL v3 Standard world with interleaved
            deck.gl simulation layers; Zustand state; scripts/ for the visual-review loop
backend/    FastAPI + Pydantic, SUMO/TraCI runner, plan compiler + validators,
            openJiuwen agents, Elasticsearch evidence, replay export
docs/       ledger: decisions, progress, blockers, capability manifest
```

See `MORNING_HANDOFF.md` for launch steps, verified demo, capability matrix and status.
See `docs/DECISIONS.md` for architectural choices and the fallback policy when sponsor
credentials are absent.

## Quick start

```sh
# backend (Python 3.12; SUMO ships inside the eclipse-sumo wheel)
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e "backend[dev]"
python -m cityshift.citypack.make_pack toronto     # OSM -> netconvert -> var/citypacks/toronto (and: waterloo)
cd backend && pytest -q && uvicorn cityshift.api.app:app --reload --port 8000

# frontend
cd frontend && npm install && npm run dev
```

Optional environment (`.env.example` lists everything): `LLM_API_BASE`/`LLM_API_KEY`/`LLM_MODEL`
(defaults to local Ollama), `ELASTIC_URL`, `VITE_MAPBOX_TOKEN`, `SENTRY_DSN`, Cloudflare R2 vars.
