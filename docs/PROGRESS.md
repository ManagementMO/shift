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
