# Proposal: residents perceive, communicate, and respond to city events

Status: event integration remains a design proposal. This PR also includes a
resident playback layout fix, described below; it does not implement the proposed
event or conversation backend. Rebased onto
`origin/main` at `73e1e45`, which merged
[PR #7](https://github.com/ManagementMO/shift/pull/7). The proposal now targets
main and its God's Plan command bar, Events menu, City log and resident panels.
Rebasing brings those entry points into the branch; the native event bridge
described here still needs implementation.

The companion [natural-language and swarm conversation proposal](SWARM_COMMAND_PROPOSAL.md)
extends the same flow to temperature, rain, roadblocks, policy changes such as
taxes, direct messages to swarms, and summaries of their recorded responses.

## Recommended outcome

An operator places an incident or describes a city change in natural language.
Residents receive the appropriate local observation or announcement, decide
what it means for their current plans, optionally discuss it, and propose a
response. The operator can also speak directly to selected residents or swarms.
The city validates and executes proposed actions; the inspector shows the
complete causal chain:

**Incident → witnessed/heard → decision → accepted/rejected action → measured outcome.**

Example: a courier sees a fire along their route, tells their customer about a
delay, and requests a detour. The customer learns about it through that message
and may revise their commitment. A distant resident who neither witnesses the
fire nor receives a warning continues their day. These are possible model choices,
not a prescribed script or a guarantee of a particular answer.

Use the existing persistent JiuwenSwarm resident sessions and actor-scoped tools.
Add a deterministic event/perception layer to the resident run; no separate
event-agent swarm or new renderer is necessary.

## What exists, and where the connection is missing

Paths below refer to main at `73e1e45` unless otherwise noted. The backend and
native runtime are unchanged from the previously inspected population head;
the new main commits integrate the UI, not incident-driven native decisions.

| System | Current behavior | Integration consequence |
| --- | --- | --- |
| [`live/contracts.py`](../backend/cityshift/live/contracts.py), `IncidentChange` / `HAZARDS` | Crash, fire, flood, tornado, gas leak; radius, warning multiplier, duration, blocked classes. | Reuse the typed authoring inputs and versioned hazard policy. |
| [`live/engine.py`](../backend/cityshift/live/engine.py), `declare_incident` | Projects lon/lat to SUMO coordinates, resolves edges, applies restrictions, posts a `SwarmEvent`. | Resolve an event against the resident run's own network and clock. |
| [`live/swarm.py`](../backend/cityshift/live/swarm.py), `Swarm.step` | Radius-based witnesses and seeded proximity gossip, with cooldowns, hop limits, bounded broadcasts and alert flags. Envelope fields resemble openJiuwen messages; delivery is local deterministic code. | Reuse perception concepts and geometry; automatic gossip must not masquerade as a native resident's decision to speak. |
| [`live/network.py`](../backend/cityshift/live/network.py), [`live/population.py`](../backend/cityshift/live/population.py) | Vehicle permissions and informed rerouting; explicit pedestrian detours/escape paths. Announced closures reroute globally; incidents do not. | Share tested routing primitives, but keep native decisions separate from programmed street reactions. |
| [`domain/hazards.py`](../backend/cityshift/domain/hazards.py) | Legacy scenario hazard corridors compile to restrictions. | A second event source, not automatically attached to population runs. |
| [`domain/society.py`](../backend/cityshift/domain/society.py) | Actor-local observations, contacts, messages, memories, decisions and authoritative task outcomes. | Add local event knowledge and event-triggered decision eligibility here. |
| [`transport/population.py`](../backend/cityshift/transport/population.py) | Separate SUMO connection, measured journeys, one active body per resident, checkpoints. No incident or mid-trip redirect API. | Apply physical effects here, on the same SUMO connection as the residents. |
| [`agents/population_bridge.py`](../backend/cityshift/agents/population_bridge.py) | Six scoped tools; one action and one message per epoch; actor, version and evidence checks. | Extend the existing proposals and validation, preserving those limits. |
| [`domain/population_runs.py`](../backend/cityshift/domain/population_runs.py) | Freeze observations, execute due native turns, commit proposals, step mobility, advance society. Publications every 300 simulated seconds and at boundaries. | Integrate events at defined boundaries and expose event progress without waiting five simulated minutes. |
| [`GodCityUI.tsx`](../frontend/src/gods-plan/GodCityUI.tsx), `commandAction` | Keyword matching opens tools; it does not parse values, apply natural-language changes, or send native messages. Closure/development entries open live tools. | Replace navigation-only submission with typed command preview and scoped conversation delivery. |
| [`CityLog.tsx`](../frontend/src/gods-plan/CityLog.tsx) | Template announcements derived from live commands plus baseline entries; visual tornadoes are labeled visual. | Use committed facts as summary inputs; this display is not currently an inbox or evidence that residents heard an announcement. |
| [`gods-plan/state.ts`](../frontend/src/gods-plan/state.ts), `GodCityUI.cast` | Tornado placement stores local visual tracks; other event effects remain unavailable in that UI. | An applied simulated event must enter the backend journal before it can affect native residents. |
| [`live/contracts.py`](../backend/cityshift/live/contracts.py), `temperature_response` | Live ambient temperature changes a synthetic cold walking model. Above 20°C its factors remain 1. | Add native environment observations; do not claim the existing model simulates heat stress. |
| [`gods-plan/demo.ts`](../frontend/src/gods-plan/demo.ts) | Agent entry points are locked by default for the frozen public demo. | Develop with the explicit local build opt-out; runtime credentials/budget still require real checks. Do not republish the frozen demo. |

Two other paths must be accounted for:

- [PR #8](https://github.com/ManagementMO/shift/pull/8), inspected at `4cc0aee`,
  proposes static point/corridor/polygon hazard geometry and rain/storm authoring
  through scenario edits. Its geometry and restriction ownership are useful
  inputs, but its scenario/replay controls should not replace the current live
  shell. It remains open and is not assumed to be on main; this design must work
  without merging #8, while leaving an adapter for its resolved geometry.
- [`TornadoDemo.tsx`](../frontend/src/babylon/TornadoDemo.tsx) is a visual sandbox.
  Particle clouds and damaged building meshes do not establish physical effects
  or resident knowledge. Previewing an event never injects it into a run.

Three non-obvious implementation gaps matter:

1. `SocietyWorld.due_residents` excludes traveling and busy residents; `_wake`
   requires an anchor. Delivering a memory alone cannot trigger a mid-trip turn.
2. The failed-turn path currently changes the resident to `waiting`. Simply
   allowing traveling residents into that path would corrupt their active trip.
3. Current hazard classes include `passenger`, `bus`, `pedestrian`; native
   residents also use `bicycle`, `delivery`, and `truck`. Copying the masks would
   leave some native vehicles unaffected.

## 1. One run owns each event and its physical effects

Introduce versioned contracts in a shared event module, independent of either
runtime. Keep these separate from `PopulationEvent`, which is already the
society's activity/outcome journal:

| Record | Proposed essential fields |
| --- | --- |
| `CityEvent` | `event_id`, `run_id`, source command ID, pack/network fingerprint, revision, discriminated payload (`incident`, `road_change`, `environment_change`, `policy_change`), effective simulated time, lifecycle status, typed scope, perception policy, explicit effects, policy version. Spatial effects carry authoritative geometry/edges/classes; policy changes carry policy ID and before/after values rather than a fake footprint. |
| `EventObservation` | Observation ID, resident ID, event ID/revision, observed/received times, source (`witness`, `message`, `announcement`), sender/message reference if applicable, hop count, bounded perceived facts. |
| Event command receipt | Idempotency key, payload hash, durable sequence, status (`queued`, `applied`, `rejected`), assigned effective time/revision or rejection reason. |

Store absolute event geometry in the pack's SUMO coordinate frame. Convert to
renderer-relative coordinates only at the display boundary. Resolve affected
edges once on the server, using the exact network fingerprint; persist the
resolved footprint for rendering, route validation and replay.

An event can be observable with no physical restriction. Rain and temperature
are environment observations; policy announcements can cause discussion without
changing a road. Rain does not become a flood, and a visible tornado does not
create building collapse or casualties.
The first physical policies are static crash and fire footprints. Define native
vehicle masks explicitly: crash blocks supported road vehicles, including
bicycles/delivery/trucks; fire additionally blocks pedestrian entry. Version and
test that policy rather than changing existing live behavior implicitly. Other
hazards remain gated until their movement behavior is tested.

Proposed operator API: `POST /api/population/runs/{run_id}/events`, with a typed
event command and idempotency key. Accept commands for an active or paused owned
run only; return a durable queued receipt. The single run worker assigns time
and applies the command at the next boundary. The request handler never calls
TraCI and never edits an in-flight native observation. Duplicate keys return
the same receipt; different content under the same key conflicts. Recheck run
status and network identity at application. Reject past-time edits and terminal
runs; recordings remain read-only. Pre-scheduled demo events use the same journal.

The live city and native population currently have separate SUMO sessions.
Placing an incident in one must not silently mutate the other. The UI explicitly
targets the active resident run. A later unified session can reuse these contracts;
sharing an event ID or copying live traveler messages is not session integration.
Menu placement and natural-language changes must call this same authority path
for a resident run. Live-session commands stay in the live controller. Do not
mark a native event applied merely because the live controller accepted it.

## 2. Perception is local; knowledge has provenance

For each resident, resolve presence from their active mobility binding and a
current measured SUMO position. Stationary residents use their declared anchor,
labeled as abstract presence; do not invent an indoor sightline. Pending
departures retain their last authoritative anchor until measured departure.
Missing/stale positions and gaps do not count as witnesses. Shared-vehicle
occupants can use the vehicle position only during a valid boarding interval.

Initially reuse radius-based warning semantics. This is a proximity model, not
ray-traced vision through buildings. Record its policy version. Membership in
the danger footprint and receipt of a warning are separate facts.

Maintain knowledge by `(resident_id, event_id, revision)`. Deliver a witness
observation on first exposure or a material update, not every simulation tick.
Only learned facts enter the resident's observation packet. Do not expose the
global event registry, unseen affected roads, other residents' private state,
or an operator's exact future expiry time. Routing feasibility may report a
constraint without revealing the cause of an unobserved incident.

Use separate delivery policies for non-geometric changes: local temperature/rain
exposure follows supported presence and scope; a citywide policy announcement
is delivered through an explicitly recorded broadcast subscription. A tax rate
does not spread by proximity unless a resident chooses to discuss it. Direct
operator messages identify their sender and reach only selected recipients.

An event ending changes physical permissions immediately. Residents learn that
it cleared through another observation, message, or declared announcement; do
not silently erase beliefs everywhere. Stale reports retain their timestamps and
source. New observation references join the actor's allowed evidence set in
`begin_epoch` / `validate_intent`.

## 3. Residents choose to communicate

Extend the existing `message` proposal with optional event-observation references
and a channel. Use the existing `propose_message` tool and city commit path:

- **Contact:** send to an existing eligible contact, matching today's direct
  message behavior. Explicitly model this as remote contact messaging.
- **Nearby:** send to one resident in the immutable nearby-contact snapshot;
  revalidate range/presence before delivery. Use a separate ephemeral recipient
  list, not permanent relationship discovery for everyone in range.

First release keeps one message plus one action per turn. Broad public shouts
and population-wide alert subscriptions can follow later. A native resident's
warning requires a completed native turn and an accepted message proposal.
Existing deterministic gossip can remain for ordinary street travelers, but
must not automatically speak on behalf of native residents.

Preserve the original observation reference through each forwarded warning,
attach sender/message IDs and hop count, and deliver no earlier than the next
simulated step. Enforce per-recipient/event/revision deduplication, cooldown and
hop limits. Resolve duplicates to the same receipt; a clearer direct witness or
a newer revision can upgrade prior second-hand knowledge without an endless
conversation loop. Message prose is an attributed claim, never authority to
change an event or routing restrictions. Residents may interpret it differently.

## 4. Wake the resident without corrupting their activity

Add explicit decision reasons and a pending interrupt queue. New local danger,
material event updates, and delivered warnings can request an interrupt while
traveling or working. Freeze the same actor-local observation boundary and use
the resident's existing persistent native session.

An interrupt turn does not make a busy resident idle. Supply `allowed_actions`
for their present activity. Permit communication and delay reporting while
moving; add a validated `reroute` proposal for an active journey and a
`seek_safety` proposal that chooses among reachable city-provided destinations.
Retain `travel`, `wait`, `rest`, and commitment revision where already eligible.
Models cannot submit arbitrary paths, teleport, claim arrival, or cancel work
by merely describing it.

`PopulationMobility` needs explicit operations to reroute the current body from
its measured edge/position. A pedestrian already on a blocked edge needs a
validated exit path: lane permissions alone do not solve that case. Keep the
same body and trip accounting across route changes. A changed destination must
update expected arrival, bindings, checkpoint metadata and affected commitments
atomically; an unchanged destination detour preserves those commitments.
Invalidate route estimates when event restrictions change. Overlapping events
combine restrictions; expiry restores only permissions no longer constrained.

For a resident already inside danger, use a bounded deterministic emergency
escape/hold policy while awaiting a usable decision. Label it `safety_rule` in
the journal, distinct from native intent. If no valid path exists, record a
trapped/blocked outcome and retain the body; do not fabricate evacuation.
Busy work cancellation must also produce explicit task transitions.

On an individual unsuccessful model turn, preserve the ongoing trip/activity
and record fallback; do not reuse the current stationary-wait mutation. A
terminal SDK/transport/protocol failure still stops the run and preserves its
partial artifacts. Budget exhaustion does not convert the rest of the run into
unlabeled programmed behavior.

## 5. Boundary ordering, cost, and durable history

At simulated time `t`, use a single serialized order:

1. Drain durable operator commands; apply event revisions/expiry and reconcile
   restrictions against current authoritative presence.
2. Deliver messages due at `t`, compute new local observations, and schedule
   interrupts. Run any required labeled emergency movement operation before
   freezing the resulting observations.
3. Freeze observations, invoke eligible native sessions, validate and commit
   proposals. Commands arriving during inference wait for the next boundary.
   No other worker mutates the world or advances SUMO during that decision.
4. Step SUMO, commit measured outcomes at `t + 1`, then repeat. Newly sent messages
   become eligible at the next boundary, never recursively in the same epoch.

Coalesce repeated notifications and prioritize immediate danger, then new
warnings, then routine decisions, with aging to avoid starvation. Apply existing
concurrency, turn/token and persistent monetary limits. Do not call a model per
frame or per gossip hop. Keep all event history durably, but bound the model
projection: prioritize active danger and newly delivered event facts, include
truncation counts, and retain actor-scoped retrieval through existing tools.
Update `swarm_service/control.py`'s prompt projection and instructions; the
current last-eight-memories/last-four-messages window alone is insufficient.

Extend the paired society/SUMO/native checkpoint with the event journal cursor,
active effects, environment/policy versions, operator conversation messages and
frozen recipient membership, each resident's knowledge, pending deliveries/interrupts,
deduplication/cooldown state and policy versions. Checkpoint sequence and event
journal position must agree before resuming. A command received after the saved
boundary is replayed exactly once. Persist routing changes with mobility state;
do not reset the budget ledger. Version the new schema; old recordings remain
readable, and incompatible resume attempts fail explicitly.

Replay renders recorded observations, decisions, accepted operations and measured
tracks without new inference. Given recorded decisions and the same inputs,
authority/perception should replay deterministically; fresh live LLM answers
are not promised to be deterministic.

## 6. User-facing flow

Use the existing God's Plan **Events menu**, bottom **command bar**, and
**Agents/People** entry points. Show the target run and its current committed
time; render supported events from capabilities of that target. Preview → Apply
queues an event; show queued/applied/rejected status. Direct swarm messages use
Send and receive attributed resident replies in the same conversation. If the
run is paused, queue the operation and use the existing explicit Resume control.
Inspection of old recordings cannot apply events or resume a different run.

`GodCityUI` currently reads the live session even while `App` displays native
recordings. The command target, weather readout, clock, City log, event visuals
and play/pause must all select the same source before enabling resident-run
commands; selecting a resident is not sufficient to switch backend authority.
Preserve the command bar's approved dimensions and position. The demo gate is
not a credential check; local development can build with
`VITE_AGENT_DEMO_MODE=false`, without changing or publishing the frozen website.

Extend the existing resident inspector with **What they know** and an event
timeline: witnessed versus heard, sender, age, decision summary, proposed action,
validation result, and measured response. An operator's global event view is
separate from that resident's known facts. Scrubbing before a delivery hides it.
Show model, programmed safety action, and fallback provenance explicitly.
City log and natural-language summaries distinguish authoritative changes,
delivered announcements, actual resident replies and aggregate observations.
An operator log entry alone must not imply that every resident learned the fact.

Keep cumulative 300-second full replay publications. Add a small versioned
incremental feed for event/observation/decision/outcome records and the matching
movement prefix, so feedback appears after each relevant boundary. Publish a
common committed-time watermark: the viewer never combines a new response with
older movement or advances beyond recorded data. The feed is inspection of
committed execution, not another live transport controller.

Reuse Babylon entities, materials, camera and picking. Check the updated controls
and inspector at 1280×600, 390×844 and 320×568.

## Delivery plan and acceptance gates

The event/conversation changes remain proposals. Implement the following as reviewable
commits in the subsequent integration work; do not call the feature complete
after only injecting prompt text.

1. **Event authority:** shared typed contracts, native-run event queue, geometry,
   class policy, environment/policy state, restriction ownership/expiry, durable
   receipts and replay schema.
2. **Perception and communication:** authoritative presence, local knowledge,
   scoped event references, contact/nearby messages, bounded prompt projection,
   interrupt scheduling and state-preserving failed turns.
3. **Physical response:** same-body rerouting and safety destinations, pedestrian
   escape, task consequences, paired checkpoint/resume and measured outcomes.
4. **Commands and conversation:** typed natural-language previews, role/roster
   recipient selection, operator inbox/replies, temperature and tax-policy
   observations, and evidence-based summaries (see the companion proposal).
5. **Visible demo:** event placement and prompts target the same resident run;
   timely coherent publications, knowledge/provenance inspection and recorded
   causal-chain playback use the current God's Plan UI.

Required regression cases:

- A witness learns; an out-of-range resident does not. Missing positions,
  stale vehicle bindings and unseen future event revisions reveal nothing.
- A completed native warning delivers once to an eligible recipient and wakes
  them next step; forged/foreign evidence and rejected/incomplete turns do not.
- A traveling resident can communicate and reroute without spawning a second
  body or becoming idle; failed turns retain the original valid trip.
- Crash/fire effects cover every declared native travel class; pedestrians can
  exit an affected edge, and an unreachable safe destination records failure.
- Duplicate commands, overlapping restrictions, expiry, paused submission,
  concurrent commands during inference and restart after acceptance are safe.
- Resume preserves knowledge, pending messages, routes and journal sequence;
  replay before learning hides the fact and performs zero model calls.
- Ordinary live incident behavior and the current renderer remain unchanged.
- Equivalent menu and natural-language commands produce the same committed
  native event; unsupported/ambiguous prompts apply nothing. Heat observations,
  scoped swarm messages and policy complaints satisfy the companion gates.

Use synthetic networks and JSON storage for deterministic/backend tests, then
the isolated native SDK tests for tool/projection and checkpoint behavior.
Finally verify a small native run with real provider execution, within an
explicitly approved remaining budget and the existing persistent caps. Record
actual model provenance and accepted physical outcomes. Rules or mocked SDK
tests do not prove live resident reasoning. This design review spent no model
budget.

For the first end-to-end demonstration, use 6–12 residents, one static fire or
crash, a witness, an eligible contact outside warning range, an uninformed control
resident, and a reachable alternate route. Then demonstrate a temperature prompt,
a direct question to a selected swarm, and a declared tax-policy announcement
with attributed resident responses. Inspect each step of the chain and its
measured movement where applicable. Defer moving/destructive tornado physics, casualties,
rescue factions, detailed life animations, thousands of native model residents,
and fully unified live/native sessions.

## Verification performed for this proposal

Re-audited main at `73e1e45`, including command dispatch, City log, demo gating,
temperature policy, native scheduler, bridge validation, SUMO trip invariants
and native prompt projection. PR #8 remains open at `4cc0aee`.
From `backend/`, ran the existing regression tests with local JSON storage:

```sh
CITYSHIFT_STORAGE=json MONGODB_URI= MONGODB_DATABASE= \
  ../.venv/bin/pytest -q tests/test_live_swarm.py tests/test_live_incidents.py \
  tests/test_live_contracts.py tests/test_live_interventions.py
```

Result: **40 passed**. From `frontend/`, `npm test --
src/gods-plan/CityLog.test.ts` passed **2 tests**. Validated **24** local source
and documentation links across both proposals; `git diff --check` passed.
These checks document existing behavior and an integration design; they do not
prove the proposed native event/command feature. No runtime code, provider
configuration, deployment or population budget ledger changed during that
proposal review.

## Implemented playback layout correction

The resident recording dock now has an independent, bounded layout rather than
inheriting the full-width live dock's minimum column sizes. Time labels, a thin
progress track, playback controls and compact counters remain inside the glass
card. The card sits above the command bar; resident panels reserve space for it.
The redundant live playback dock is hidden during resident inspection, and its
Space shortcut defers to recorded playback.

Verified the card at 1280×600, 390×844 and 320×568, including keyboard Home/End
scrubbing. Frontend: 370 tests passed, lint passed with four existing City log
Fast Refresh warnings, and TypeScript/production build passed with the existing
chunk-size warning. This UI correction changes no model execution or budget.
