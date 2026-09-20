# Native resident city

Opening the city now restores a compatible saved JiuwenSwarm population or opens native swarm setup. It does not create the former 600 rule-driven traffic participants. SUMO remains the movement authority for native residents.

1. Open **Agents** or **People and agent groups**. Inspect saved residents without using models.
2. Choose **Create a native swarm**, a count, duration, budget and reviewed model families. Creation assigns persistent personas, contacts, homes and model sessions without inference. New anchors are distributed across connected streets around CN Tower/Rogers Centre; the outline marks the activity district, not an impassable wall.
3. Choose **Start new society run** to execute models. The default is 100 residents for 10 simulated minutes, with a $5 per-run cap. The application and isolated adapter accept up to 100 residents; decisions still execute in small budget-admitted batches. Multiple selected families are distributed across residents through OpenRouter. This is the configured trial scale, not a claim that every resident has already completed a live model turn.
4. Place rain, storm, flood, fire or tornado from **Events**, set temperature from **Weather**, or send a message in the prompt. Explicit absolute temperatures such as “Set the temperature to 35°C” become temperature observations. Other text is an operator announcement, not an unimplemented tax or policy change.
5. Click a resident or select a roster entry. The inspector leads with the recorded model-generated decision summary and shows the actual model, accepted/rejected action, plans, beliefs, memories, messages and outcomes. It does not expose private chain-of-thought or invent model records for failed turns.

Inputs to running or paused runs are appended to a durable inbox. Paused runs need explicit Resume. Inputs while inspecting completed recordings wait for a new run, leaving the archive unchanged. Spatial incident inputs reach residents within the declared radius at the authoritative boundary; travelers retain the warning for their next eligible arrival decision. Contact messages travel through the existing society message authority.

The warning itself does not force evacuation, choose an action, close native transport routes, or simulate injuries. Models may choose supported travel, waiting, rest, commitment changes, and contact messages according to their persona and observation. Applied warnings have time-correct map effects; queued inputs are not displayed as completed execution.

Native execution publishes one atomic snapshot at initialization and each decision boundary. **Latest** follows published decisions; scrubbing or playing history disables following. Playback pause is separate from execution pause. The simulation never displays invented movement beyond a published snapshot.

The operator approved removing the fixed $20 application-session ceiling. With `CITYSHIFT_POPULATION_PROVIDER_BUDGET=1`, the application uses the verified provider-key balance, preserving the full historical ledger. The status reports a null session limit and the available provider balance. Per-run ceilings remain separate ($5 by default, configurable up to $20). Reviewed worst-case request reservations are checked before each native batch; a run that cannot admit another request checkpoints and pauses.

Put `OPENROUTER_API_KEY` in ignored `backend/.env`, never in frontend configuration. Restart the backend to load it. For a deliberately replaced key, also set `CITYSHIFT_POPULATION_ADOPT_PROVIDER_KEY=1` for the restart; this permits adoption in provider-budget mode without deleting previous usage. The approved provider policy uses `CITYSHIFT_POPULATION_APPROVED_40_KEY=1` for a non-renewing key cap of at most $40 with no BYOK usage. The old fixed-session behavior remains available when provider-budget mode is off.

Saved recordings remain inspectable across this update. Paired execution checkpoints attest the source rules, so an older-code checkpoint may reject Resume; it is never silently reset or migrated. Create a new run to exercise updated rules.

Local verification covers deterministic event scope, receipt persistence, checkpoint resume, message causality, atomic snapshots, native-only entry and UI history isolation. These tests do not establish successful paid model execution of a newly added event response.
