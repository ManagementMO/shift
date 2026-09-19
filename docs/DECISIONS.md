# Decisions ledger

Each entry: what was decided, why, and what would change it.  Newest last.

## D-001 SUMO from the `eclipse-sumo` wheel, not Homebrew
The `dlr-ts/sumo` Homebrew formula fails on this machine (`undefined method cxxstdlib_check`).
The PyPI wheel ships `sumo`, `netconvert`, `duarouter`, etc. under `site-packages/sumo/bin` and sets
`SUMO_HOME` on import.  `cityshift.transport.sumo_env.binary()` resolves binaries from there first,
then PATH.  Reversible: set `SUMO_HOME` to any external 1.27 install.

## D-002 Local Ollama (`qwen2.5:7b`) is the default model provider
No Baseten key is provisioned.  Ollama exposes an OpenAI-compatible endpoint with tool calling,
which openJiuwen's `ModelClientConfig` accepts.  The adapter reads `LLM_API_BASE`, `LLM_API_KEY`,
`LLM_MODEL`; pointing them at Baseten switches providers without code change.  Every
`AgentDecision` records `provider` and `model`, so the handoff never claims Baseten was used
when it was not.

## D-003 Elasticsearch runs locally (9.1.4 tarball) unless `ELASTIC_URL`/`ELASTIC_API_KEY` are set
Same client library either way.  Elastic is a rebuildable projection: SQLite/JSON files under
`var/` are authoritative for scenarios, plans, runs, evidence bundles.

## D-004 MapLibre + OpenFreeMap tiles by default; Mapbox Standard when `VITE_MAPBOX_TOKEN` exists
deck.gl `MapboxOverlay` works with both.  No Mapbox token is available, so shipping a
Mapbox-only scene would render a blank page.  Vehicle/trail/hazard layers are identical in
both modes; only the basemap adapter differs.

## D-005 Transport truth is recorded from TraCI, not parsed from prose
`SumoRunner` samples every vehicle and person each second and records state transitions.
SUMO reports the "waiting for ride" and "riding" phases with the same stage type (3, driving);
they are distinguished by whether a vehicle is assigned.  Metrics are derived only from these
records plus `tripinfo`.

## D-006 Scheduled stops use `until`, not just `duration`
A service plan with a fixed dwell cannot hold a bus for a wave of travelers.  `Duty` departures
compile to `<stop until="...">` so plans are time-tabled and validators can check temporal overlap
between duties of the same physical bus.

## D-007 Initial commit pushed to `main` so a PR can exist
The repository was empty (no default branch).  A minimal `README.md` + `.gitignore` commit was
pushed to `main`; all real work lives on a feature branch and PR.  The user was away and asked
for uninterrupted overnight progress; this is the least invasive way to satisfy "always open a PR".

## D-008 City pack from OpenStreetMap (Waterloo, ON) via netconvert
Real road geometry, sidewalks, and GRT bus stop nodes, converted with `netconvert --osm-files`.
The pack is labelled `real_data=true` for geometry and the demand set is labelled `synthetic=true`.
If OSM download is impossible on the network, the fallback pack is the synthetic tiny corridor,
labelled as such in the UI.

## D-009 The city is the interface: Mapbox owns geography, deck.gl owns measured entities
The three-column dashboard was removed.  Mapbox GL v3 Standard renders terrain, buildings, roads and
labels; simulation entities (buses, cars, people, stops, restrictions, hazard) are interleaved deck.gl
layers placed at three invisible anchor slots (`bottom`/`middle`/`top`) so layer order never changes
between frames.  Moving Mapbox layers per frame caused a repaint loop; fixed anchors removed it.

## D-010 A hazard is a declared moving region, not weather physics
`HazardTrack` (path, radius, start/end) is compiled deterministically into timed edge restrictions.  The
tornado-like column, debris and pulses are visual decoration of that footprint.  The UI copy says
"modeled hazard region"; nothing forecasts or simulates a storm.

## D-011 Non-finite TraCI samples are missing measurements
Teleporting vehicles report `INVALID_DOUBLE_VALUE` (serialized as Infinity, invalid JSON).  Such
samples are dropped and a trail break recorded; the renderer never interpolates across a break.
Angle/speed carry the previous finite value.  Alternative (clamping) was rejected: it invents positions.

## D-012 Closure integrity audited from SUMO's own exit-times
`vehroute-output.exit-times` gives a per-edge occupancy interval, so a vehicle that left a closed
edge before the closure is not a violation, one that entered during it is ("entered"), and one already
on it is reported separately ("caught").  Without exit-times the audit falls back to a conservative
trip-level overlap.
