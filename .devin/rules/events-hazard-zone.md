---
description: "CITY//SHIFT hazard-zone workstream: declared footprints, honest simulation semantics, and integration checks."
trigger: always_on
---

# Event-family context: hazard zone

## Intent and status

- Seeded on 2026-09-19 for branch `events-hazard-zone`, created from `events` at `dc9afa7a55e61050dc3874dfe2ea347e5544a15b`.
- The user requested independent Herdr worktrees for five event families, followed by context seeding. This handoff does not start or authorize implementation, agents, commits, or merging; follow the next explicit task.
- Families: crowd surge, road disruption, service shortage, hazard zone, and development/new buildings. Details below are proposed scope and integration guidance, not a finalized event framework.
- Apply this context to hazard-zone work, not unrelated tasks after future merges.

## Product goal and proposed first slice

Let users define a flooded road corridor, storm exclusion area, or fire perimeter and measure transport consequences.

- A hazard is a declared exclusion footprint with explicit spatial and temporal assumptions. It is not a weather forecast, hydrology model, fire-spread model, or casualty simulation.
- Start with a static point/corridor footprint and start/end window, compiled to actual restrictions on supported vehicle modes.
- Preview exact affected edges, confirm a child scenario, then test service responses while preserving the parent.
- Make no-op footprints and unusable areas visible instead of pretending an effect occurred.
- A moving or expanding hazard is a later capability unless time-varying per-edge restrictions are implemented and verified end to end. Visual motion alone does not establish moving simulation semantics.

## Current implementation and entry points

- `backend/cityshift/contracts.py::HazardTrack`: lon/lat waypoints, radius in meters, start/end seconds, modes, and label. `ScenarioSpec` has both hazards and restrictions. Mirror API changes in `frontend/src/types.ts`.
- `backend/cityshift/domain/hazards.py::hazard_footprint_edges` projects coordinates through the SUMO network and finds edges near the entire path. `hazard_restriction` creates one restriction for the full footprint over the full hazard window, not a moving series of closures.
- The generated restriction filters modes to `passenger` and `bus`; default `HazardTrack` includes `pedestrian`, but pedestrian hazard enforcement is not implemented by that conversion. Do not claim pedestrians are protected by it.
- `backend/cityshift/domain/edits.py`: storm/hazard/flood text resolves named places, defaults radius to 250 m, and extends a single named point roughly 600 m northeast with a warning. A spatial editor should make geometry explicit rather than silently inheriting that extension.
- Applying a storm stores both its `HazardTrack` and derived restriction; `source_claim_id` is `hazard:<track_id>`. Keep those two representations consistent.
- `frontend/src/shell/ToolPanel.tsx::HazardTool` calls this path and currently calls it a moving hazard. `ProposalCard.tsx`, `ghost.ts`, `ScenarioDrawer.tsx`, and `store.ts` handle preview and branching.
- `frontend/src/world/layers.ts` and `replay.ts` contain hazard-related map/replay logic. Inspect Babylon support independently in `frontend/src/babylon/WorldBabylon.tsx`, `WorldCanvas.tsx`, and `overlay.ts`; do not assume an optional Mapbox visualization exists in the default renderer.
- `backend/cityshift/domain/compiler.py`, `network.py`, `runs.py`, and `transport/sumo_xml.py` are the common restriction/route/audit pipeline. Actual code takes precedence over older "moving hazard" wording in documentation.

## Integration boundaries and risks

- Coordinate with `events-road-disruption` on restriction ownership, overlapping time windows, and reopening. Removing one event must not clear an independent active hazard or leave an orphaned hazard visual.
- Use one deterministic footprint for preview, persisted scenario, compiler, and audit. Do not maintain an independently guessed frontend list of blocked roads.
- Reject invalid/non-finite coordinates, malformed paths, invalid radii, foreign edges, and invalid time windows. Account for the pack's supported extent and access modes.
- If implementing true movement later, define path timing, boundary behavior, edge-entry semantics, and replay synchronization before promising it in the UI.
- Preserve crowd/development demand and service-shortage constraints from sibling worktrees. A hazard footprint is not automatically an evacuation demand generator.
- Keep Python/TypeScript contracts aligned, maintain immutable lineage and meaningful scenario/run identity, and limit broad shared-file refactors for integration.

## Suggested acceptance tests

- Deterministic sorted footprints, radius monotonicity, point/line geometry, and correct network-coordinate projection.
- Full-window footprint semantics are labeled truthfully; affected modes match actual SUMO restrictions.
- Preview/cancel is non-mutating; confirm stores matching hazard/restriction geometry and timing. Parent scenarios remain unchanged.
- Empty footprints, invalid geometry, overlapping manual closures, and hazard removal have explicit outcomes.
- A tiny SUMO run verifies blocking/detours or unroutability and closure timing; count every traveler and distinguish vehicles caught inside from illegal entry.
- Inspect the preview and replay in Babylon and, where available, Mapbox; decoration must not imply unsupported physical behavior.
- Existing examples: `backend/tests/test_evidence_edits_agents.py` for footprint growth and storm edits, `backend/tests/test_closure_audit.py` for audit timing, and `backend/tests/test_transport_tiny.py` for measured transport behavior.

## Environment and verification

Read `README.md`, `docs/DECISIONS.md`, and `docs/LOCAL_DEMO_AND_REVIEW.md`. Their historical runtime checks do not configure this checkout. Keep synthetic assumptions visible and do not describe the output as a calibrated emergency forecast.

Use Python 3.12+ and backend dev dependencies in an environment importing this checkout. Generated `var/`, `.venv/`, `node_modules/`, and local secrets are not inherited by a new worktree. Do not copy secrets or change sibling environments/checkouts. Coordinate server ports; Vite currently proxies `/api` to port 8000.

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

Waterloo-dependent tests skip without that generated city pack; report skips separately. No test runs or simulations were performed for context seeding. Future implementation requires measured verification, not just a compelling hazard animation.
