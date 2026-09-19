---
description: "CITY//SHIFT development/new-buildings workstream: persistent city changes, trip generation, and integration boundaries."
trigger: always_on
---

# Event-family context: development and new buildings

## Intent and status

- Seeded on 2026-09-19 for branch `events-development`, created from `events` at `dc9afa7a55e61050dc3874dfe2ea347e5544a15b`.
- The user specifically asked about new buildings after the initial disruption discussion. They then chose five event-family worktrees and asked to seed context so they can explore integration.
- The five families are crowd surge, road disruption, service shortage, hazard zone, and development/new buildings. This handoff is not an autonomous implementation task or authorization to launch agents, commit, or merge. Follow the user's next request.
- Apply this context to development work. The proposed scope is not a final shared schema or an instruction to implement every building type.

## Product goal and proposed first slice

Broaden the app from incidents to persistent what-if city changes: "What happens if 500 apartments open here?"

- Recommended first presets: apartments/residential, offices, and schools. They have meaningfully different travel patterns. Retail, hospitals, stadiums, and industrial developments are later possibilities, not requirements for the first slice.
- Residential development produces departures/returns; offices attract commuters; schools produce scheduled arrival/dismissal waves. Model direction and timing explicitly rather than relabeling identical venue-egress demand.
- Suggested flow: place a building/footprint, select use and capacity (units, employees, or students), review travel assumptions, preview, confirm a scenario branch, then compare transport outcomes and possible service responses.
- Height or a mesh alone must not imply demand. Any mapping from units/floors to people and trips needs declared, editable assumptions, not guessed occupancy presented as fact.
- First connect trips to validated access on existing roads/walking networks. New streets, driveways, bridges, or lane geometry are separate network changes, not required merely to display a building.
- Expanding or converting an existing building is a useful follow-up. Distinguish construction-phase closures/traffic from post-opening demand; do not conflate both effects by default.
- This is a synthetic transport experiment, not a calibrated planning forecast, zoning/permit check, property valuation, utility-capacity model, or medical-outcome simulator.

## Baseline implementation and entry points (before this worktree's implementation)

- `backend/cityshift/citypack/world.py` compiles static OSM buildings and geography into `world.json`. Buildings have visual categories/heights but are not attached to a building-driven transport demand model.
- `frontend/src/babylon/worldData.ts`, `city.ts`, `WorldCanvas.tsx`, and `WorldBabylon.tsx` are renderer entry points; inspect coordinate and geometry conventions before adding scenario overlays. Babylon is the default, with Mapbox optional.
- `backend/cityshift/contracts.py`: `Traveler` already has origin/destination edges, but `CityPack` is organized around one venue and a list of destination zones. `ScenarioSpec` has no development model. Update `frontend/src/types.ts` consistently if contracts change.
- `backend/cityshift/domain/demand.py`: all generated origins are `pack.venue_edge_id`; departures follow one venue-egress distribution. Building attraction, multiple origins, return trips, and persistent land-use demand are not implemented.
- `backend/cityshift/domain/compiler.py` needs explicit review for multi-origin support: cohort cars use the pack venue rather than each traveler's origin; walking-distance caching uses destination only; heuristic plans choose venue pickups and pack-zone drop-offs. A new building demand generator alone will not fix these assumptions.
- `compiler.py::_nearest_allowed` assumes a nearby candidate exists. Building placement must validate connected, mode-appropriate access rather than crashing or inventing a connection. `zone_for_stop` also assumes declared pack destination zones.
- `backend/cityshift/api/service.py::apply_edit` reuses parent demand. `store.py` stores demand under scenario ID and rejects overwriting scenarios. New persistent developments need real scenario/demand persistence and identity.
- `frontend/src/shell/ToolPanel.tsx`, `store.ts`, and `api.ts` contain existing tools and branching. Structural road/intersection tools are placeholders for network rebuilds; there is no functioning add-development tool in this baseline.

## Integration boundaries and decisions to resolve

- Coordinate a shared demand-input and origin/destination approach with sibling `events-crowd-surge`; avoid two parallel, incompatible demand engines. Keep single-venue behavior working while generalizing it.
- Consider scenario-local development overlays rather than overwriting generated base `world.json` or the shared city pack. Decide how geometry, capacity, travel assumptions, and derived trips are serialized and restored before implementing the UI.
- Include every meaningful development/demand input in scenario identity. Current demand IDs only encode pack/count/seed; flagship IDs additionally encode horizon. `domain/runs.py::run_id_for` hashes scenario/plan/seed, not the full demand body.
- Preserve incumbent traveler identities and separate new development trips. A growing cohort cannot be compared as though all travelers are matched; report existing travelers' impacts and added travelers separately, with clear denominators.
- Compose construction restrictions through `events-road-disruption`, keep `events-hazard-zone` independent, and treat transit changes in `events-service-shortage` or explicit response plans as separate interventions.
- Keep changes to shared contracts/compiler/API/store/UI small and explain their interface for integration. No generic event registry or final development schema has been agreed.

## Suggested acceptance tests

- Type, capacity, position, and schedule change actual origin/destination demand deterministically; reload restores the same assumptions and geometry.
- Multiple origins reaching the same destination use origin-specific walking distances and car starting edges. Venue regression cases still pass.
- Off-network, disconnected, outside-pack, and unsupported-mode placements give explicit validation rather than bogus nearest-edge access.
- Preview/cancel persists nothing; applying preserves the original pack, parent scenario, existing traveler IDs, and unrelated events.
- Demand/scenario/run identities change when meaningful inputs change, and parent/new-population comparisons do not claim false traveler matching.
- Real trips, queues, and outcomes change in SUMO; adding only a visible building is not feature completion. Unreachable trips remain counted.
- Existing references: `backend/tests/test_transport_tiny.py` for transport accounting, `backend/tests/test_citypack_build.py` for pack behavior, and `frontend/src/babylon/coords.test.ts`, `geometry.test.ts`, and `city.test.ts` for rendering/geometry conventions. Add focused multi-origin and development-persistence regressions.

## Environment and verification

Read `README.md` and `docs/LOCAL_DEMO_AND_REVIEW.md`. Its runtime results describe a previous checkout, not this fresh worktree. The current demonstration is venue egress, not an existing calibrated citywide commuting model.

Use Python 3.12+ with backend dev dependencies and imports pointing to this checkout. `.venv/`, `node_modules/`, generated `var/`, and local secrets are not inherited. Do not copy secrets, repoint a shared editable install, or modify sibling checkouts. Vite's API proxy currently targets port 8000; coordinate before launching multiple servers.

From `backend/`, after setup:

```sh
python -m pytest -q
python -m ruff check .
python -m mypy cityshift
```

From `frontend/`, after setup:

```sh
npm test
npm run lint
npm run build
```

Some integration tests skip without the generated Waterloo pack; report prerequisites and skipped checks. Context seeding did not run tests or simulations. Any later implementation must separately verify backend semantics, persistence, rendering, and honest before/after comparisons.

## Implementation integration notes

- This worktree's development interface is `ScenarioSpec.developments` (input specification plus validated, mode-specific access) and optional `Traveler.development_id` / `trip_direction`. It extends the existing demand/compiler path, not a generic event registry. Preview/apply endpoints are `/api/scenarios/{sid}/developments/preview` and `/apply`; return waves are explicitly independent one-way trips.
- `run_id_for(scenario, plan, seed, demand)` now includes the full demand body and excludes the scenario creation timestamp. Runs snapshot their scenario and demand; cohort artifacts include final states and per-trip waiting seconds for population-aware comparison.
- Atlas is selected with `CITYSHIFT_STORAGE=mongodb`; `CITYSHIFT_STORE` is accepted only as a legacy alias when the canonical variable is absent. Credentials belong only in ignored local environment configuration. Large city packs and SUMO/replay artifacts remain local. No implicit storage fallback or automatic JSON-to-Atlas migration occurs.
- Tests must not use the live Atlas database. From `backend/`, run `CITYSHIFT_STORAGE=json MONGODB_URI= MONGODB_DATABASE= ../.venv/bin/python -m pytest -q`; MongoDB tests use an in-memory mock. The empty credential overrides prevent dotenv from importing live credentials into verification commands.
- On this macOS installation, OSM downloads work with `SSL_CERT_FILE=/opt/homebrew/etc/openssl@3/cert.pem`, using the existing trusted system CA bundle. Do not disable TLS verification. Toronto and Waterloo assets were generated locally with that environment setting.
- `frontend/scripts/check-development.mjs` exercises real Babylon placement, preview/cancel, confirmation/reload, real SUMO runs, and parent comparison. It refuses non-local servers and refuses any backend whose reported storage is not JSON. Build the frontend first, then start an isolated backend on port 18171 with the JSON/empty-credential overrides above; run `node scripts/check-development.mjs http://127.0.0.1:18171` from `frontend/`.
- The browser check uses the ignored `var/playwright` browser cache. Install Chromium from `frontend/` with `PLAYWRIGHT_BROWSERS_PATH=../var/playwright PLAYWRIGHT_SKIP_BROWSER_GC=1 ./node_modules/.bin/playwright install chromium`. On this machine, `NODE_EXTRA_CA_CERTS=/opt/homebrew/etc/openssl@3/cert.pem` supplies the trusted CA bundle for browser downloads. Screenshots go to ignored `visual-reviews/`.
