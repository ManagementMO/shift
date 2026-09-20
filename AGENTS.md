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
- The renderer uses reverse depth. In Babylon 9.26, `DirectionalLight.shadowFrustumSize` does not reverse the projection depth; use explicit orthographic bounds with automatic extent updates disabled. Shadow tests cover both depth order and camera-independent projection.
- This worktree's `/tornado` route is a read-only visual destruction demo. Run `npm run dev -- --host 127.0.0.1 --port 5175 --strictPort` from `frontend/` against the existing API on port 8000; it does not submit SUMO runs or mutate scenarios.
- Tornado, smoke and building-collapse poses are derived from absolute simulation time. `DISPLAY_SCALE = 10` maps simulation seconds to demonstration seconds; tests in `destruction.test.ts` and `smoke.test.ts` cover rewind and resource cleanup.
- Reload the browser after changing imperative Babylon classes: HMR alone can leave existing scene objects on the old implementation. Vite and TypeScript caches are local to `frontend/.cache/` so shared dependency folders are not used for build metadata.
