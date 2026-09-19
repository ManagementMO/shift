# Progress log

Append-only.  Times are UTC.

- 2026-09-19 03:00  Environment inventory: empty repo, no secrets, macOS arm64, Node 24, Python 3.12.
- 2026-09-19 03:20  SUMO 1.27.1 (pip wheel), traci, sumolib, openJiuwen 0.1.18 installed in `.venv`.
- 2026-09-19 03:40  Ollama 0.34.2 running, `qwen2.5:7b` pulled, tool-call round trip verified.
- 2026-09-19 03:50  Elasticsearch 9.1.4 tarball extracted to `~/tools/elasticsearch-9.1.4`.
- 2026-09-19 04:00  Backend package, contracts, SUMO XML writer, tiny corridor fixture, TraCI runner.
- 2026-09-19 04:25  Phase B proven: `tests/test_transport_tiny.py` 4/4 pass (board/alight/arrive,
                    capacity overflow leaves 3 waiting, persistent bus return cycle carries 6, missing
                    line keeps traveler accounted as waiting).
- 2026-09-19 04:30  Initial commit on `main`; feature branch created.
- 2026-09-19 05:10  Waterloo OSM pack via netconvert; two-bus compiler + validators; run orchestration; HTTP API.
- 2026-09-19 05:40  First frontend (MapLibre/deck.gl replay, inspector, comparison, typed edit preview).
- 2026-09-19 06:00  Agents (openJiuwen ReAct over Ollama), frozen evidence bundles (local ES), NL edits.
- 2026-09-19 07:00  Visual reset brief received; Mapbox token provided (stored in frontend/.env.local only).
- 2026-09-19 08:00  Toronto OSM pack (downtown/waterfront, ~89k edges, 188 stops), flagship egress scenario, base runs.
- 2026-09-19 09:30  Full-screen world shell: Mapbox Standard + interleaved deck.gl, dock, tool rail, Swarm Lens, compare.
- 2026-09-19 10:30  Storm branch from a prompt; hazard footprint/column; closure audit with exit-times.
- 2026-09-19 11:00  Replay JSON hardened (non-finite TraCI positions dropped, trails broken); storm run rerun.
- 2026-09-19 11:15  Seven visual reviews regenerated; agent bubble anchored while paused; handoff written.
