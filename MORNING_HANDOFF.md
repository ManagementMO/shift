# CITY//SHIFT — morning handoff

Written at the end of the unattended overnight session (2026-09-19, UTC). Everything below is
classified as **tested** (executed and checked this session), **fixture/replay** (works on recorded
or synthetic data), **fallback** (a sponsor path replaced by a local equivalent), **untested**, or
**unavailable**. Nothing here claims a sponsor integration ran when it did not.

## Launch (macOS arm64, this machine)

```sh
# 1. services (both were left running; restart if the machine rebooted)
# model provider: backend/.env holds the OpenRouter key (LLM_API_BASE/KEY/MODEL); without it, Ollama is the fallback:
# ollama serve &                                           # local model provider, qwen2.5:7b
~/tools/elasticsearch-9.1.4/bin/elasticsearch -d           # local evidence index, :9200

# 2. backend (:8000) — packs + store live under var/ and are rebuilt by the commands below
cd ~/repos/shift && source .venv/bin/activate
python -m cityshift.citypack.make_pack waterloo            # skips steps whose outputs exist
python -m cityshift.citypack.make_pack toronto
(cd backend && uvicorn cityshift.api.app:app --port 8000)

# 3. frontend (:5173); Mapbox Standard needs VITE_MAPBOX_TOKEN in frontend/.env.local (gitignored)
cd frontend && npm install && npm run dev

# 4. reproduce the seven visual reviews (needs 2 + 3 running)
frontend/scripts/shoot-all.sh                              # -> visual-reviews/01..07.png
```

First-time data: `POST /api/scenarios/flagship {"pack_id":"toronto","seed":7,"cohort_size":240,"horizon_s":2700}`
creates the flagship scenario; `POST /api/scenarios/{sid}/plans` with `family=baseline|direct|split`
proposes deterministic plans; `POST /api/runs {"scenario_id","plan_id"}` runs SUMO. The UI does all of
this from the scenario drawer / tool rail / command bar.

## Verification run before handoff

| check | command | result |
|---|---|---|
| backend tests | `cd backend && ../.venv/bin/pytest` | 24 passed |
| backend lint | `../.venv/bin/ruff check cityshift tests` | passed |
| backend types | `../.venv/bin/mypy cityshift` | no issues, 33 files |
| frontend types | `cd frontend && npx tsc -b` | passed |
| frontend lint | `npm run lint` | passed (warnings only) |
| frontend build | `npm run build` | passed (chunk-size warning) |
| visual loop | `frontend/scripts/shoot-all.sh` | 7/7 screenshots written |
| browser E2E | persistent testing agent, real SUMO runs, Mapbox Standard (recording on PR #1) | 7 pass, 3 fixed after the run (scenario list collapse, Share link, Waterloo switch) |

## Capability matrix

| # | capability | status | evidence |
|---|---|---|---|
| 1 | Operator enters problem + constraint | tested | Swarm Lens › Agents form → `POST /api/scenarios/{sid}/investigate` |
| 2 | City evidence retrieved and frozen (`EvidenceBundle`, content hash) | tested, **fallback** | local Elasticsearch 9.1.4, fixture corpus per pack; `inv-1cff0f46bb` bundle `eb-d025d133079f` |
| 3 | Bounded agents propose plans (openJiuwen ReAct, real tools) | tested | **OpenRouter** `openai/gpt-4o-mini` (key in gitignored `backend/.env`, `LLM_API_BASE=https://openrouter.ai/api/v1`): Toronto `inv-39e55d8705` completed end-to-end in ~90 s — evidence bundle `eb-cb7ea40f34d2`, 4 ranked zones, two agent plans (`agent-direct-5d8705`, `agent-split-5d8705`, both buses, both `VALID`), SUMO run `run-ec76c0406e99` from the direct one. Fallback without a key: Ollama `qwen2.5:7b` (analysts complete, planner's JSON step timed out on 7B: `inv-cb6578e86d`). Backboard adapter (`BACKBOARD_API_KEY`, thread API + `/llm/v1` shim for openJiuwen) is wired and unit-tested but the account's free credit does not cover chat (HTTP 402) — untested live. Deterministic `direct`/`split`/`baseline` plans always exist. |
| 4 | Deterministic validators reject infeasible plans | tested | `tests/test_evidence_edits_agents.py` (validator cases); `POST /api/scenarios/{sid}/validate`; `run-2f499e256f50` is an `invalid` run kept as a record |
| 5 | Valid plans execute in real SUMO 1.27.1 (TraCI-sampled) | tested | Toronto `run-95fc14e23d20` (baseline), `run-b50e803f5069` (direct-top2); Waterloo ×3 |
| 6 | UI renders measured trajectories, passenger states, restrictions, timeline, metrics | tested (replay) | `visual-reviews/02`, `03`; positions come from `tracks.json` samples only; teleports break trails |
| 7 | Journey inspection (select a person/bus, bubble, Why? → Swarm Lens trace) | tested | `visual-reviews/04`; bubble anchored to recorded position, Agent camera follows |
| 8 | Typed scenario edits with ghost preview → branch → rerun | tested | `visual-reviews/05` (closure preview), storm branch `…-v941c7c` created from a prompt via `/edit/preview` + `/edit/apply` |
| 9 | Counterfactual branches, parents immutable | tested | branch scenario has its own id/runs; parent runs unchanged |
| 10 | Compare mode (baseline left / candidate right, synced camera + clock) | tested (browser E2E: held drags on both sides stayed aligned, one scrub moved both) | `visual-reviews/07`; PR #1 recording |
| 11 | Modeled moving hazard (footprint, timed edge restrictions, column/debris visual) | tested (replay) | `visual-reviews/06`; `run-c11bd36b44c5`; declared hazard region, **not** tornado physics |
| 12 | Closure integrity audit (vehroute exit-times, entered vs caught) | tested | `tests/test_closure_audit.py`; run warnings list counts |
| 13 | Mapbox GL v3 Standard 3D basemap | tested | token in `frontend/.env.local` only; falls back to MapLibre + OpenFreeMap without it |
| 14 | Share / replay export | **fallback** | local zip export (`POST /api/runs/{rid}/export`); Cloudflare R2 path is credential-gated and unexercised |
| 15 | Sentry | **unavailable** | DSN-gated no-op |
| 16 | Elastic Cloud, Baseten | **unavailable** | same client code, different env; never exercised |
| 17 | Browser end-to-end by a persistent testing agent | tested once | recording + screenshots on PR #1; found: scenario list collapsed at normal zoom, Share showed a server path, no city switch — all three fixed in the follow-up commit; luma.gl uniform-reflection console messages remain (not exceptions) |
| 18 | Babylon.js `/world` preview (migration in progress; Mapbox `/` unchanged) | tested (screenshots + unit tests) | W1 world compiler `world.json` (34,804 SUMO edges as `WorldRoad`, 10,461 buildings, landmarks) + coordinate service; W2 replay-driven thin-instanced buses/cars/people aligned to the SUMO net; W3 crowd LOD (figure ≤420 m, ground marker beyond / from city camera), release pulses at each recorded venue depart, state tallies, **Egress** hero camera at Rogers Centre; W4 the full shell (top strip, sim dock, tool rail, command bar, camera modes, agent bubble, Swarm Lens) runs on Babylon via a `SyncMap` adapter — click-to-select travellers/vehicles with halo + dim, follow camera, closures/ghost/focus drawn on SUMO edges. `docs/visual-reviews/w1..w4-*.jpg`; `frontend/src/babylon/*.test.ts` (28 tests). Bare renderer lab at `/world/lab`. Not yet: Babylon compare split, infrastructure edits, Havok/tornado (W5–W8); W4 was verified by screenshot + unit tests, not browser E2E |

## Scenario and run ids worth opening

- Toronto flagship: `concert-egress-toronto-n240-h2700-s7` — baseline `run-95fc14e23d20` (194/240 completed,
  median 1015 s, 9 teleports) vs direct-top2 `run-b50e803f5069` (198 completed, 90 boardings, 1296 waiting
  person-minutes, 13 unroutable vs 42).
- Storm branch: `concert-egress-toronto-n240-h2700-s7-v941c7c` — one hazard track (venue → Union, 250 m,
  810–1890 s), two restrictions; baseline `run-c11bd36b44c5` (192 completed, 40 teleports, 24 closure
  crossings classified 23 entered / 1 caught).
- Waterloo: `concert-egress-waterloo-n120-h2700-s7` with three completed runs (regression scenario).

## Known limitations (honest list)

- 42 cohort travelers in the Toronto base scenario are unroutable at compile time (pedestrian network
  gaps in the OSM extract); they are counted, never dropped silently.
- Teleports (SUMO jumping a jammed/closed vehicle) are recorded as trail breaks and counted; the storm
  branch has 40 because the closures cut the corridor it declares.
- Local 7B planner: the free-form sketch works; strict JSON formatting sometimes times out under load.
  Baseten/any larger model fixes this without code changes.
- Browser console still shows Mapbox Standard warnings (`lineMetrics` for style-internal layers, "map
  container should be empty" from the deck.gl overlay slot anchors). Cosmetic; tracked, not fixed.
- Hazard column is deck.gl meshes (cones + debris), not a Three.js custom layer. Same visual contract,
  less code; a Three.js layer is a contained follow-up in `frontend/src/world/layers.ts`.
- `visual-reviews/*.png` are not committed (34 MB); regenerate with `shoot-all.sh`.

## Decisions taken without you

See `docs/DECISIONS.md` (D-001…D-008) plus: Mapbox token stored only in `frontend/.env.local`; storm
visual reads as a "declared moving hazard region"; screenshots regenerated after every visual fix rather
than hand-edited.

## Next steps that need you

1. Review the PR diff. Browser E2E ran once (see the PR comment); the three UI failures it found were fixed
   afterwards and verified by screenshot, not re-run end-to-end.
2. Optional sponsor credentials: `BASETEN_API_KEY` (+`LLM_API_BASE`, `LLM_MODEL`), `ELASTIC_CLOUD_URL` +
   `ELASTIC_API_KEY`, `SENTRY_DSN`, `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET` (+`R2_PUBLIC_BASE_URL`).
3. Decide whether the hazard visual should move to a Three.js custom layer.

## Roadmap for the team (Babylon migration, in priority order)

What exists after W1–W4: `/world` is the whole product on the Babylon miniature Toronto; `/` is the same
product on Mapbox/deck.gl. Everything below the renderer (SUMO, validators, agents, edits, replay
artifacts) is shared and unchanged. Suggested order, with the concrete seams to build on:

1. **Compare on Babylon (W7)** — `CompareSplit` still mounts two `WorldMap`s. Give it a renderer prop
   (same pattern as `App`), mount two `WorldBabylon`s (`side="left"|"right"`); the camera sync already
   goes through `registerMap`/`SyncMap`, so the divider and clock sync should work with no new plumbing.
   Two Babylon engines on one page: budget ~2× the 10k-building geometry — consider sharing `world.json`
   parse via the existing `loadWorld` cache.
2. **Infrastructure edits with ghosts (W5)** — `Overlay.set()` already draws ghost edges/stops from
   `store.ghost`. Add-stop is UI + a new edit `kind` (`contracts.py` `ScenarioEdit.kind`, applied in `domain/edits.py`)
   that inserts a stop on an existing edge and re-runs the compiler; catchment = 400 m disc, snapped via
   `RoadIndex.nearest()`. Add-road /
   add-intersection need a `netconvert` rebuild: implement as a backend job (`citypack/build.py` →
   child pack id) and reuse the existing `building` state for the "Building alternate Toronto…" veil.
3. **Events (W6)** — a `WorldEvent` contract (`{kind: collision|tornado|flood|fire, t0, t1, footprint,
   edge_ids}`) that (a) becomes timed restrictions via `domain/hazards.py` (already how the storm works)
   and (b) is rendered by Babylon: Havok (`@babylonjs/havok` is installed, not yet enabled) for
   collision debris, GPU `ParticleSystem` for the tornado, animated water plane for flood. Keep the
   SUMO-side effect authoritative; visuals are decoration of a recorded restriction.
4. **Make `/world` the default (W8)** — flip `Root.tsx`, keep `/mapbox` as fallback, re-run the
   screenshot loop (`frontend/scripts/shoot.mjs`) for reviews 01–09 and the testing-agent E2E on the
   Babylon route. Until then, run the Babylon route through the browser E2E at least once.

Engineering debt worth paying early:
- **Picking** is a screen-space nearest-entity scan (`Traffic.pick`, 22 px). Fine at ~400 entities;
  switch to Babylon GPU picking or a screen-space grid before scenarios grow past a few thousand.
- **Zoom ↔ radius** in `mapAdapter.ts` is a Web Mercator approximation so Mapbox-era poses
  (`world/camera.ts`) work on Babylon. When Mapbox is retired, express poses natively in metres and
  delete the conversion.
- **Mobile / low-end GPUs**: 10k extruded buildings + CSM shadows. Add a quality toggle (shadows off,
  building chunks by distance) before demoing on laptops without discrete GPUs.
- **Traveller kinds** are `bus | car | person`; the Mapbox `Selection` type also has `stop` and
  `restriction`. Both routes honour all five, but Babylon draws stops as discs only — a stop bubble with
  boardings (data already in `metrics.json`) is a cheap win.
- **Rotate both pasted keys** (Backboard, OpenRouter) — they were shared in chat.
