# Blockers and open questions

| id | blocker | impact | workaround in place | needs |
|----|---------|--------|---------------------|-------|
| B-1 | No Baseten API key | sponsor model path unverified | local Ollama `qwen2.5:7b`, same OpenAI-compatible adapter | `BASETEN_API_KEY`, model name |
| B-2 | ~~No Mapbox token~~ resolved 2026-09-19 | Mapbox Standard verified | token in `frontend/.env.local` (gitignored) | — |
| B-3 | No Elastic Cloud credentials | cloud evidence path unverified | local Elasticsearch 9.1.4 | `ELASTIC_URL` + `ELASTIC_API_KEY` |
| B-4 | No Sentry DSN | error reporting unverified | DSN-gated adapter, no-op locally | `SENTRY_DSN` |
| B-5 | No Cloudflare credentials | public replay unverified | local replay export + worker skeleton | `CLOUDFLARE_API_TOKEN`, `R2_BUCKET` |
| B-6 | overpass-api.de returns 406 from this network | OSM download | mirror (`overpass.kumi.systems`) or OSM API `map` call | none if a mirror works |
| B-7 | Local 7B planner times out on strict-JSON step under load | agent-proposed plans sometimes absent (deterministic plans always exist) | two-step sketch→format, one repair round, 600 s timeout | larger model (`BASETEN_API_KEY`) |
