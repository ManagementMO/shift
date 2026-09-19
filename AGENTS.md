# Project verification

- Frontend commands run from `frontend/`: `npm test`, `npm run lint`, and `npm run build` (includes TypeScript checking).
- The existing npm lockfile needs `npm ci --legacy-peer-deps`; a plain `npm ci` attempts to resolve peer dependencies absent from the lockfile. Do not regenerate the lockfile just to install it.
- Browser playback checks: `node scripts/check-playback.mjs http://127.0.0.1:5173`. They require the backend and an existing city pack/scenario, mock simulation runs, and block other API writes. Set `CITYSHIFT_LIVE_REPLAY=1` to additionally verify visible car movement, pause/resume, and the activity jump against a real completed replay without modifying backend data.
- Real replays can have a long quiet intro. `buildIndex` computes `activityStart` from moving-track density; new replays autoplay there, while rewind/scrubbing still cover the full recording.
- Set `PLAYWRIGHT_CHANNEL=chrome` to use installed Google Chrome when Playwright-managed Chromium is unavailable.
- `/` and `/world` use the Babylon renderer. `/mapbox` is the explicit Mapbox alternative and requires `VITE_MAPBOX_TOKEN`; no MapLibre fallback is mounted. `/world/lab` is the standalone renderer preview.
- Main viewers allow free orbit, pan, and zoom alongside City/District/Corridor/Agent/Incident presets. Presets provide bounded framing without locking subsequent input; resizing must preserve the user's camera position. `fixedCamera` is opt-in, and pointer/wheel input cancels an active preset flight.
