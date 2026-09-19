# Toronto cityscape experiment

Developed on `demo/toronto-cityscape` in `/Users/mo/Downloads/shift-cityscape`, then integrated with the Waterloo E7 work on `main`.

The standard local app serves the cityscape at <http://127.0.0.1:5174/showcase> and the full simulation at <http://127.0.0.1:5174/>. The isolated worktree below remains available for further experimentation.

## Preview

- Immersive viewer: <http://127.0.0.1:5175/showcase>
- Full Babylon simulation: <http://127.0.0.1:5175/>
- Mapbox alternative: <http://127.0.0.1:5175/mapbox>
- Bare renderer workbench: <http://127.0.0.1:5175/world/lab>

The full simulation has a **Cityscape** link. The viewer has a return link to the simulation. Babylon is still the default renderer.

The isolated frontend proxies `/api` to port **8001**, selected by `CITYSHIFT_API_URL` in ignored local configuration. It uses its own copied `var/` directory for city packs, scenarios and recorded runs. The original checkout and its ports 5174/8000 are separate. Vite's project defaults remain 5174/8000; `CITYSHIFT_WEB_PORT` and `CITYSHIFT_API_URL` override them per worktree.

From this worktree, start the two processes in separate terminals:

```sh
# Reuse the original environment's installed dependencies; cwd controls which source is imported.
cd /Users/mo/Downloads/shift-cityscape/backend
CITYSHIFT_API_PORT=8001 /Users/mo/Downloads/shift/.venv/bin/python -m uvicorn cityshift.api.app:app --host 127.0.0.1 --port 8001
```

```sh
cd /Users/mo/Downloads/shift-cityscape/frontend
npm ci --legacy-peer-deps
CITYSHIFT_API_URL=http://127.0.0.1:8001 npm run dev -- --host 127.0.0.1 --port 5175 --strictPort
```

A fresh machine can instead create a Python 3.12 environment and install `backend[dev]` as in the root README. It must generate/copy the Toronto city pack and create a completed SUMO run to see recorded movement. The bundled visual assets require no network service at runtime. Mapbox still needs its own ignored `.env.local` token setting.

## Controls and visual systems

The four compositions frame downtown, Rogers Centre, Union Station and the waterfront. Use the buttons or **1–4**. Drag to orbit, right-drag to pan, scroll/pinch to zoom. **H** hides the interface; **Space** toggles the recorded traffic. Afternoon/golden-hour and isometric/perspective controls are in the upper right. Reset returns to the orthographic downtown composition. Reduced-motion preferences skip preset flights and water animation.

In the simulation, strategic modes use orthographic projection and agent inspection uses perspective. Comparison mode keeps cameras and the replay clock synchronized. Babylon panes share exact world-space camera poses, including target height and projection, to avoid repeated geographic round-trip drift.

The visual work includes:

- An orthographic city camera with eased, named compositions.
- 1,562 official downtown massing records aligned to the simulation's world frame; 1,703 overlapping OSM fallback footprints replaced only in the renderer.
- Twelve reusable façade recipes, procedural podiums/setbacks for suitable surrounding buildings, roof equipment and cornices. Courtyards and concave-lot safeguards remain in place.
- Four dedicated Blender landmark GLBs, loaded asynchronously with procedural fallbacks.
- PBR materials with shared textures, normal maps for selected surfaces, a CC0 sky environment, directional shadows, restrained ambient shading, and subtle water movement.
- Curbs, crossings, street trees, lights, shelters, rail beds/ties/rails, and shoreline coping, promenade pieces, bollards and benches.
- Nearby and distant tree detail levels in 400 m spatial batches, and a limited radius for tree shadows. Buildings retain spatial batches.

The **high** profile renders at device pixel ratio up to 2, uses 1024px façade textures, 16× anisotropic filtering (subject to hardware support), 2× MSAA where supported, 3072px two-cascade shadows, and half-resolution ambient shading. It falls back to FXAA if MSAA is unavailable. Comparison panes use a **balanced** profile: device ratio 1, 512px façades, 1024px shadows, FXAA and no ambient-shading pass. Their static city shadow maps refresh on camera, model or lighting changes; moving traffic does not cast shadows in this profile. Repeated geometry/materials are reused within each scene.

This is a bounded downtown visual prototype. Landmark details, façade assignments and furniture are illustrative. It does not add new agents, alter sponsor integrations, invent traffic or change measured simulation outcomes. Dataset reduction is described in [asset provenance](../frontend/public/assets/city/ASSETS.md).

## Rebuild assets

The committed files in `frontend/public/assets/city/` are sufficient to run the viewer. Regeneration is optional. Raw GIS files belong under ignored `var/cityscape-source/`.

1. Download the official 2025 multipatch archive linked in the asset provenance file and extract `3DMassingMultipatch_2025_WGS84.gdb` into `var/cityscape-source/`.
2. Ensure `var/citypacks/toronto/world.json` exists for coordinate alignment.
3. Extract surfaces and reduce them:

```sh
uv run --no-project --python 3.12 --with fiona --with pyproj --with shapely python scripts/build_cityscape_massing.py
uv run --no-project --python 3.12 --with shapely python scripts/optimize_cityscape_massing.py
```

The raw downtown surface extract is about 284 MB; the optimized browser asset is about 3.75 MB. The optimizer recomputes fallback exclusions from retained geometry, so discarded source records do not leave holes in the city.

Regenerate the landmark GLBs with Blender (tested with 5.2.2 LTS):

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/build_landmarks.py
```

## Verification

```sh
cd frontend
npm test
npm run lint
npm run build
```

Tests cover texture ownership/disposal, camera projection and reduced-motion jumps, courtyard preservation, vegetation detail-level lifecycle, optional-asset fallback and network mismatch protection, plus the existing geometry, coordinates, roads and replay interpolation suite. Browser verification must include loaded landmark GLBs, all camera presets, lighting, projection switching, replay pause/resume, and synchronized comparison panes. Frame rates depend on viewport size, GPU, camera and background work; record them as local observations, not guarantees.

The integrated frontend suite passed 63 tests; lint and the production build passed. The build still reports the existing large-renderer-chunk advisory. Targeted Waterloo backend checks passed 6 tests with one optional local-pack check skipped because the E7 pack was absent in the isolated runtime. A native-Retina downtown browser sample after the clarity upgrade measured approximately 37–41 fps at 2482×1526 rendering resolution; this was a local observation, not a cross-device benchmark.
