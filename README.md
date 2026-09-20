# Concrete Consequences

Give the city a problem and a resource constraint. Watch agents test possible responses.

Concrete Consequences is a transportation scenario laboratory: a city problem (a concert letting out
during a road closure) plus a fixed resource limit (two extra buses, one operating window)
becomes a set of candidate service plans, each compiled into a real SUMO simulation and
measured on the same cohort of travelers.  Agents propose; deterministic validators reject
infeasible plans; SUMO decides what actually happens; the UI replays the recorded truth.

```
frontend/   React + TypeScript + Vite; default Babylon.js 3D city, optional Mapbox Standard
            renderer with deck.gl simulation layers; shared Zustand state and replay controls
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
cd frontend
npm ci --legacy-peer-deps
npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Open <http://127.0.0.1:5174/> for the **interactive globe**. Select any location to descend into
the Toronto prototype. `/world` opens the city directly, with automatic playback, free camera
controls, and city camera presets. `/world/lab` is the bare Babylon workbench.
Generate the city pack before opening the default renderer; its `world.json` is local data.

The **Mapbox Standard 3D alternative** is at <http://127.0.0.1:5174/mapbox>. To use it, set
`VITE_MAPBOX_TOKEN` in `frontend/.env.local` and restart Vite. The token is not required for
Babylon. The Developer panel links between the two interfaces. Local environment files and
generated city/run data are ignored by Git.

Optional backend environment (`.env.example` lists everything): `LLM_API_BASE`/`LLM_API_KEY`/`LLM_MODEL`
(defaults to local Ollama), `ELASTIC_URL`, `SENTRY_DSN`, Cloudflare R2 vars.

See [the local demo and project review](docs/LOCAL_DEMO_AND_REVIEW.md) for verified results,
architecture, integration status, and Hack the North priorities.

## Toronto cityscape preview

The immersive `/showcase` viewer upgrades the
default Babylon renderer with official downtown massing, dedicated landmark GLBs, PBR
materials, street details and an isometric camera. See [the cityscape guide](docs/TORONTO_CITYSCAPE.md)
for the standard and isolated local previews, controls, rendering profiles and asset rebuild instructions.
The [asset provenance file](frontend/public/assets/city/ASSETS.md) records sources and geometry limits.
