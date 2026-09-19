# Project verification

- Frontend commands run from `frontend/`: `npm test`, `npm run lint`, and `npm run build` (includes TypeScript checking).
- The existing npm lockfile needs `npm ci --legacy-peer-deps`; a plain `npm ci` attempts to resolve peer dependencies absent from the lockfile. Do not regenerate the lockfile just to install it.
- Browser playback checks: `node scripts/check-playback.mjs http://127.0.0.1:5173`. They require the backend and an existing city pack/scenario, mock simulation runs, and block other API writes.
- Set `PLAYWRIGHT_CHANNEL=chrome` to use installed Google Chrome when Playwright-managed Chromium is unavailable.
- `/` uses Mapbox (MapLibre without a token), `/world` uses the Babylon renderer with the same shell, and `/world/lab` is the standalone renderer preview.
- Main viewers lock camera input and fit the viewport inside the city bounds on resize; camera presets and follow/frame actions must not bypass this lock. Only `/world/lab` keeps a free camera for renderer work.
- Keep the MapLibre fallback in deck.gl overlay mode: MapLibre 6 removed `map.transform`, which deck.gl 9.4's interleaved mode still reads. Mapbox can remain interleaved.
