# Local setup

- Python environment: `uv venv --python 3.12 .venv`, then `uv pip install --python .venv/bin/python -e 'backend[dev]'`.
- Frontend locked install requires `npm ci --legacy-peer-deps` from `frontend/`; plain `npm ci` fails on missing peer dependencies in the existing lockfile. Do not regenerate the lockfile just to install it.
- Build city data from the repository root: `.venv/bin/python -m cityshift.citypack.make_pack toronto waterloo`.
- Backend: from `backend/`, run `../.venv/bin/uvicorn cityshift.api.app:app --host 127.0.0.1 --port 8000`.
- Frontend production preview: from `frontend/`, run `npm run build` then `npm run preview -- --host 127.0.0.1 --port 5173`. The `/world` route uses Babylon and needs no Mapbox token.
- Verification: `cd backend && ../.venv/bin/pytest -q`; from `frontend/`, `npm test`, `npm run lint` and `npm run build` (includes TypeScript checking).
- Browser playback checks: `node scripts/check-playback.mjs http://127.0.0.1:5173`. They require the backend and an existing city pack/scenario, mock simulation runs, and block other API writes. Set `CITYSHIFT_LIVE_REPLAY=1` to additionally verify visible car movement, pause/resume, and the activity jump against a real completed replay without modifying backend data. Set `PLAYWRIGHT_CHANNEL=chrome` to use installed Google Chrome when Playwright-managed Chromium is unavailable.
- `/` opens the globe; `/world` opens the city directly. Both use Babylon. Every globe destination routes to the Toronto prototype. `/mapbox` is the explicit Mapbox alternative and requires `VITE_MAPBOX_TOKEN`; no MapLibre fallback is mounted. `/world/lab` is the standalone renderer preview; `/showcase` is the isometric cityscape viewer.
- Product name: Concrete Consequences. Visual preference: minimal near-black UI, off-white type, thin borders, sharp corners, monochrome globe by default. No decorative orbital rings, wireframe, star field, blue HUD accents, or duplicate location sidebar. Locations are selected directly on the globe; configuration lives in Settings.
- Globe layout: Settings is docked permanently on the left (`SimulationSettings docked`), the globe sits in the centre, and Recent work (real scenarios/runs from the API, `frontend/src/globe/recentItems.ts`) is on the right. Selecting a recent item flies into Toronto and then selects that scenario; `store.selectScenario` is request-guarded so a slower earlier selection cannot overwrite it. The city keeps the Settings trigger button in its top strip.
- Globe input is rotation-only. Keep wheel and pinch zoom disabled and radius bounds locked to the viewport fit; only the scripted city-entry flight unlocks the radius.
- City controls are deliberately simplified (upstream PR #2): no Compare split view and no free-text command bar; prompt-to-edit lives in the agents lens. Replays autoplay from `activityStart` (moving-track density computed by `buildIndex`); a scenario without runs auto-submits its baseline plan. Main viewers allow free orbit, pan, and zoom alongside City/District/Corridor/Agent/Incident presets; presets frame without locking input, resizing preserves the camera, `fixedCamera` is opt-in, and pointer/wheel input cancels an active preset flight.
- Investigation preferences (AI enablement, candidate count, reasoning steps, Elasticsearch use) are persisted in the browser and snapshotted into each investigation. AI-off also disables the LLM fallback for edit previews. Provider credentials remain server-side; preferences never start services or store keys.
- Globe imagery and country borders load from public three.js / Natural Earth sources; the globe can still select destinations if external imagery fails. The Toronto scene prewarms behind the globe, with city rendering and keyboard shortcuts suspended while hidden.
- After changing the world compiler, regenerate each existing pack with `.venv/bin/python -m cityshift.citypack.world toronto` (and `waterloo`). Restarting the server alone does not regenerate the JSON.
- Terrain surface partitions preserve intersection precision. Do not round their exported vertices to the source geometry’s 0.1 m grid: this creates overlapping slivers at angled boundaries.
- Overlapping building footprints are reconciled into vertical sections with exposed roof polygons. Preserve `source_id` / `source_height` for appearance, render `roofs` rather than the full footprint, and never apply the legacy 3 m minimum height to reconciled sections.
- Official Toronto massing (`frontend/public/assets/city/toronto-massing.json`) is never rendered raw. `cityshift.citypack.massing.prepare_massing` verifies alignment (matching network, embedded coordinate frame, or the verified legacy asset hash + CN Tower anchor), reconciles overlapping tiers, clips OSM fallback footprints, and writes `var/citypacks/toronto/massing.json`, served at `/api/packs/toronto/massing`. Regenerating Toronto (`python -m cityshift.citypack.world toronto`) refreshes it.
- City camera: perspective is the product default (globe arrival). `/showcase` and `/world/lab` opt into isometric via `camera.setPreferredProjection`; the Settings drawer exposes Overview and Lighting for the full app.
- The Babylon city uses PBR materials, the textured cloud sky with the world-edge fade plugin (no scene fog), landmark GLBs and street furniture from main, on top of the world-aligned single shadow map. Street details and trees are placed on the compiled surface height and keep `TREE_CLEARANCE` from building footprints.
- The renderer uses reverse depth. In Babylon 9.26, `DirectionalLight.shadowFrustumSize` does not reverse the projection depth; use explicit orthographic bounds with automatic extent updates disabled. Shadow tests cover both depth order and camera-independent projection.

## Weather events worktree (events-hazard-zone)

### User preference

- At the end of every response that touches the running app, remind the user which frontend endpoint to open.
- Weather-event clouds use soft particle effects inspired by `demo/tornado-mvp`, not visible solid 3D parts.
  Shadows must feather out without a hard circular edge; storm rainfall falls vertically.
- Clicking an incident selects it and shows a small × above its visual. Only that × removes the incident.
- The weather picker offers Rain / Storm only. Fire authoring and its brush were removed at the user's request;
  existing Fire/Flood records remain readable and removable for saved-scenario compatibility.

### Frontend endpoints (events-hazard-zone worktree)

- Current weather preview: `http://127.0.0.1:60970/world` proxies to `http://127.0.0.1:8147`.
  Started with `.venv/bin/uvicorn fire_review_app:app --app-dir var --host 127.0.0.1 --port 8147`.
  The ignored review wrapper copies scenarios, demand, plans and completed runs from the existing 8146 test server
  into another in-memory MongoDB test double; keep 8146 running when starting it. No Atlas or source-server writes.
- Previous review server (real Toronto pack + synthetic `hazard-preview` pack, in-memory MongoDB test double, real local SUMO
  runs, serves the built frontend): `http://127.0.0.1:8146` — started with
  `.venv/bin/uvicorn hazard_browser_app:app --app-dir var --host 127.0.0.1 --port 8146` from the worktree root.
  It seeds the Toronto flagship scenario at startup so the globe (`/`) has somewhere to land; `/world` opens the
  city directly. Rebuild the frontend (`npm run build`) before restarting it.
- The Toronto pack was built here with `make_pack toronto` from OSM tiles copied from `~/shift/var/osm/toronto`
  (and `toronto_water`); Overpass/OSM downloads fail on this machine with a TLS certificate error, so reuse those
  caches rather than re-fetching. `node test-results/toronto-globe-review.mjs` exercises globe → Toronto → rain → apply.
- Previous browser preview: `http://127.0.0.1:57136` (8146, pre-Fire backend); use 60970 for current weather work.
- Full dev setup: Vite on `http://127.0.0.1:5174` proxies `/api` to the FastAPI backend on port 8000.
  Ports 5174 and 8000 may already be taken by sibling checkouts (`waterloo` worktree, `~/shift`); check
  `lsof -nP -iTCP:<port> -sTCP:LISTEN` before assuming a server belongs to this worktree.

### Verification

- Backend (from `backend/`): `../.venv/bin/python -m pytest -q`, `../.venv/bin/python -m ruff check .`,
  `../.venv/bin/python -m mypy cityshift`. Waterloo/E7 tests skip when those city packs are not built.
- Frontend (from `frontend/`): `npm test`, `npm run lint`, `npm run build`.
- Browser flow (needs the current review server and a fresh `npm run build`): `node test-results/weather-events-review.mjs`
  from `frontend/`; it places, drags, applies, moves, inspects and deletes a weather event and writes screenshots
  to `frontend/test-results/weather-events/`. `node test-results/weather-visuals-look.mjs` applies rain and storm
  and captures animation frames to `frontend/test-results/weather-look/`. These scripts default to 8147 and accept
  `CITYSHIFT_REVIEW_URL` for another review server. `node test-results/placement-cursor-review.mjs` checks the live cursor.
- `node scripts/check-weather-controls.mjs http://127.0.0.1:8147` requires the isolated `cityshift_browser_test`
  database and `hazard-preview` fixture. It checks particle clouds, soft shadows, vertical rainfall and explicit ×
  removal. Screenshots go to `frontend/test-results/weather-controls/`. `node scripts/check-fire.mjs` checks that
  Fire authoring and its brush are absent from the weather tool.
- `node scripts/check-weather-apply.mjs http://127.0.0.1:8147` checks Rain / Storm Apply at nonzero playback
  times, including the interval while a child run is being generated and the handoff to its replay.
- Weather add/move/delete branches preserve the edit-time playback position, speed and paused/playing intent through
  scenario selection and delayed replay loading. Ordinary scenario navigation still starts at recorded activity.
- Review servers import backend code at startup. Preserve the in-memory review metadata before restarting them.
- Weather materials are named `hazard-*`; `atmosphere.ts` exempts that prefix from the sky fade so effects stay vivid.
- Custom material plugins need an explicit unique define (e.g. `HAZARD_SPREAD_FRONT`) as well as extra-event registration
  for per-frame binds. Otherwise Babylon's DetailMap plugin can leave them sharing a cached plain-material shader.
- The picker offers Rain / Storm. Historical Fire/Flood records remain readable and removable without migration.
  Historical Fire spread is illustrative within its fixed footprint; closures do not expand.
