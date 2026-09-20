# Resident inspection in the current city

PR #7 adds persistent JiuwenSwarm residents to the Babylon city. The original
resident interface exposed their personas, recorded decision summaries, plans,
beliefs, memories, messages, relationships, tasks and measured journeys. This
reconciliation restores direct access to those records while retaining main's
textured buildings, landmark assets, vehicle and person geometry, live city,
camera/navigation, closures and responsive shell.

## Audit of the original PR commits

| Commit | Contribution | Reconciliation decision |
| --- | --- | --- |
| `d650533` | Isolated native SDK, persistent resident identities, scoped tools, city authority, mobility, checkpoints and recorded inspection | Keep the runtime and inspection semantics; adapt their presentation to the current shell. |
| `7e6b80e` | Reproducible SDK patch regression proof after a clean install | Preserve. |
| `760546c` | Stop society execution on terminal native runtime/protocol failure | Preserve; failed execution must not appear completed. |
| `db9d9f8` | Reconcile main's live Babylon city and HD renderer with native residents | Keep the city. Restore the lost resident bubble, following, passenger access and visible inspection. |
| `b0d9f50` | Preserve main's closures and city-load recovery | Preserve. |
| `b9c1e5c` | Remove obsolete Mapbox configuration | Preserve. |

The current README describes the broader hackathon ambition. The implemented
population contracts, original inspector and original AGENTS.md establish what
this PR actually records. The native gate remains 20 residents; the ordinary
many-traveler street simulation does not become an LLM population through this
UI change.

## What was missing

The rich `ResidentInspector` survived the merge, but main's live-only
`AgentBubble` returned nothing for resident selection. The remaining inspector
was below setup, run controls, playback and the roster in a narrow scrolling
panel. Shared vehicles also lost links to their recorded resident passengers.

Opening the real saved trial revealed a second blocker: frontend validation
still limited `tokens_per_minute` to 500,000, although the backend and native
default used 5,000,000, with a contract maximum of 20,000,000. The frontend now
matches that contract. Monetary limits and persistent accounting are unchanged.

## Inspection flow

1. Open **AI residents** and choose a saved population. Its most recent usable
   recording opens without dispatching inference.
2. Click a person, resident-owned vehicle or hollow stationary marker, or choose
   a person in the searchable roster. The details panel opens immediately.
3. Read the latest recorded summary and actual decision source/model, proposed
   action, authority acceptance, observed outcomes, current plan and beliefs.
   Expand the task, memory, message, relationship and provenance sections.
4. Use **Follow** or **Frame** to find the resident. Identity persists across
   walking, cycling, driving, delivery vehicles and stationary presence. Shared
   bus inspection lists its recorded passengers instead of assigning ownership
   to an arbitrary rider.
5. Scrub **Recorded** time in the bottom dock. Future summaries, task versions,
   memories, messages and framework mappings stay hidden. Person heading is
   reconstructed from recorded segments so backward scrubbing does not reverse
   their facing direction.
6. **Return to street simulation** restores the live traffic source. Cached
   resident records cannot reinterpret live entity selections.

The full inspector remains available on smaller screens; the redundant compact
map bubble is hidden there. Follow, Frame, Close and the history playhead remain
accessible. Stationary presence stays an explicitly abstract anchor marker;
there are no invented interior positions or detailed life animations.

New definitions expose a per-run USD cap (initially $1, bounded by remaining
session budget) and the configured brains. Defining residents is separate from
explicit model execution. Saved runs retain engine, seed, warnings and partial
execution status.

## Verification

- Backend: 514 tests passed, 13 data-dependent checks skipped; Ruff and mypy
  passed. Native SDK: 47 tests passed, Ruff and patch attestation passed.
- Frontend: 348 tests passed; lint, TypeScript and production build passed.
  The existing production chunk-size warning remains.
- Browser: opened the existing 12-resident native recording in the current
  textured city and selected a resident through the roster. Recorded summaries
  and actual model identity appeared in the dedicated panel. The same Babylon
  scene and material identities remained in use. Clicking the resident's map
  marker opened the same inspector; the visible playhead returned to time zero
  and showed the earlier summary instead of the later decision.
- Layout checked at 1440×900, 1280×720, 1024×600 and 390×844. Local screenshots
  are in ignored `var/visual-reviews/resident-ui/`.
- Browser verification used local JSON storage and disabled paid population
  execution. This pass made no new paid model calls and did not reset the ledger.

The browser exercise inspects prior recorded execution. It does not establish
new model behavior, larger native population support or outcomes absent from
the saved artifacts.
