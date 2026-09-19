# Local setup

- Python environment: `uv venv --python 3.12 .venv`, then `uv pip install --python .venv/bin/python -e 'backend[dev]'`.
- Frontend locked install requires `npm ci --legacy-peer-deps` from `frontend/`; plain `npm ci` fails on missing peer dependencies in the existing lockfile.
- Build city data from the repository root: `.venv/bin/python -m cityshift.citypack.make_pack toronto waterloo`.
- Backend: from `backend/`, run `../.venv/bin/uvicorn cityshift.api.app:app --host 127.0.0.1 --port 8000`.
- Frontend production preview: from `frontend/`, run `npm run build` then `npm run preview -- --host 127.0.0.1 --port 5173`. The `/world` route uses Babylon and needs no Mapbox token.
- Verification: `cd backend && ../.venv/bin/pytest -q`; from `frontend/`, `npm test` and `npm run build`.
- `/` opens the globe; `/world` opens the city directly. Both use Babylon. Every globe destination routes to the Toronto prototype. `/mapbox` is the alternative city renderer.
- Product name: Concrete Consequences. Visual preference: minimal near-black UI, off-white type, thin borders, sharp corners, monochrome globe by default. No decorative orbital rings, wireframe, star field, blue HUD accents, or duplicate location sidebar. Locations are selected directly on the globe; configuration lives in Settings.
- Globe input is rotation-only. Keep wheel and pinch zoom disabled and radius bounds locked to the viewport fit; only the scripted city-entry flight unlocks the radius.
- Investigation preferences (AI enablement, candidate count, reasoning steps, Elasticsearch use) are persisted in the browser and snapshotted into each investigation. AI-off also disables the LLM fallback for edit previews. Provider credentials remain server-side; preferences never start services or store keys.
- Globe imagery and country borders load from public three.js / Natural Earth sources; the globe can still select destinations if external imagery fails. The Toronto scene prewarms behind the globe, with city rendering and keyboard shortcuts suspended while hidden.
- After changing the world compiler, regenerate each existing pack with `.venv/bin/python -m cityshift.citypack.world toronto` (and `waterloo`). Restarting the server alone does not regenerate the JSON.
- Terrain surface partitions preserve intersection precision. Do not round their exported vertices to the source geometry’s 0.1 m grid: this creates overlapping slivers at angled boundaries.
- Overlapping building footprints are reconciled into vertical sections with exposed roof polygons. Preserve `source_id` / `source_height` for appearance, render `roofs` rather than the full footprint, and never apply the legacy 3 m minimum height to reconciled sections.
- Official Toronto massing (`frontend/public/assets/city/toronto-massing.json`) is never rendered raw. `cityshift.citypack.massing.prepare_massing` verifies alignment (matching network, embedded coordinate frame, or the verified legacy asset hash + CN Tower anchor), reconciles overlapping tiers, clips OSM fallback footprints, and writes `var/citypacks/toronto/massing.json`, served at `/api/packs/toronto/massing`. Regenerating Toronto (`python -m cityshift.citypack.world toronto`) refreshes it.
- City camera: perspective is the product default (globe arrival). `/showcase` and `/world/lab` opt into isometric via `camera.setPreferredProjection`; the Settings drawer exposes Overview and Lighting for the full app.
- The Babylon city uses PBR materials, the HDR sky environment, landmark GLBs and street furniture from main, on top of the world-aligned single shadow map. Street details and trees are placed on the compiled surface height and keep `TREE_CLEARANCE` from building footprints.
- The renderer uses reverse depth. In Babylon 9.26, `DirectionalLight.shadowFrustumSize` does not reverse the projection depth; use explicit orthographic bounds with automatic extent updates disabled. Shadow tests cover both depth order and camera-independent projection.
