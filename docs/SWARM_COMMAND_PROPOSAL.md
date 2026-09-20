# Proposal: talk to the city and its resident swarms

Status: proposed behavior, not implemented by the accompanying playback UI fix.
This document extends the
[resident event proposal](RESIDENT_EVENT_PROPOSAL.md), based on `origin/main`
at `73e1e45`. The existing command bar, Events menu and City log are the product
entry points. The native command/conversation behavior below remains to be built.

The branch now also includes main through `7903714`: live weather/fire placement
and local visual plane commands are preserved. The audit below describes the
earlier baseline; these newer street/visual commands do not yet deliver changes
or conversations to native resident sessions.

## Intended experience

The user can change conditions in ordinary language, talk directly to a resident
or a group, and read a natural-language account of their responses. Each group's
members retain their individual identities, knowledge, commitments and choices.
They can disagree, complain, warn one another or change plans; the interface
must not manufacture unanimous reactions.

| Example prompt | Authoritative operation | Possible resident response |
| --- | --- | --- |
| “Set the city temperature to 35°C.” | Commit an ambient temperature change in the selected resident run and deliver scoped environment observations. | A resident expresses discomfort, rests, discusses the heat, or changes a supported plan. |
| “Make it rain here for ten minutes.” | Resolve the selected area and simulated duration, then commit a supported rain observation policy. | Residents discuss rain or revise travel plans; rain does not automatically create flooded roads. |
| “Put a tornado here” / “Close Front Street.” | Resolve a declared incident/road change, using the same native authority path as menu placement. | Witnesses and informed residents warn contacts, detour, or seek safety using validated actions. |
| “Raise the local income-tax rate from 10% to 12%, and announce it.” | Validate the selected policy's actual baseline, then commit its rate revision and a scoped announcement. | Some affected residents may complain, others support it or stay silent. |
| “Couriers, how is the heat affecting your deliveries?” | Deliver an attributed question to the selected courier residents; no world mutation. | Members answer from their own observations and commitments. |
| “Residents downtown, please move away from the fire.” | Deliver a group objective to resolved residents. | Individuals propose eligible actions; a request is not evidence that evacuation occurred. |
| “Summarize their reactions.” | Read recorded replies/decisions and outcomes at the selected time. | An evidence-linked account, including disagreement and missing responses. |

Examples describe desired capabilities, not capabilities already present on
main. A target advertises which environment, policy and movement operations it
supports; unavailable ones explain the missing capability rather than succeeding
as decorative effects.

## What the new main supplies

- [`GodChrome.tsx`](../frontend/src/gods-plan/GodChrome.tsx) supplies the persistent
  “Tell the city what happens…” command bar.
- [`GodCityUI.tsx`](../frontend/src/gods-plan/GodCityUI.tsx)'s `commandAction`
  currently opens tools through keyword matching. “Temperature” opens a form;
  it does not parse a value or dispatch an event to JiuwenSwarm. Citizen Message
  and Guide handlers explicitly say they are not connected.
- [`PeoplePanels.tsx`](../frontend/src/gods-plan/PeoplePanels.tsx) supplies group
  and individual UI components, but a displayed group is not a native recipient
  registry. [`LivePeoplePanel.tsx`](../frontend/src/gods-plan/LivePeoplePanel.tsx)
  lists measured street travelers; those IDs are not interchangeable with native
  resident identities.
- [`CityLog.tsx`](../frontend/src/gods-plan/CityLog.tsx) produces template
  announcements, not model-generated resident opinions or delivered messages.
- The backend's older [`domain/edits.py`](../backend/cityshift/domain/edits.py)
  translates some prompts into scenario edits. Reuse name-resolution/typed
  validation ideas, not its obsolete scenario-fork execution path.

Neither a rebase nor swapping these display components creates the missing
connection. The population event bridge and moving-resident decision support
in the companion proposal remain prerequisites.

## One command entry point, three explicit intents

Propose `POST /api/population/runs/{run_id}/commands/preview` returning a typed
`CommandProposal`. Its union is `world_change`, `speak`, or `query`; include the
original text, resolved target, expected world revision, scope, effective-time
policy and a concise interpretation. The command bar shows that interpretation.

1. **World change:** produce a typed event/environment/policy operation. Preview
   displays before/after values, scope and units, then the existing Apply pattern
   submits through the event journal. Resolve “increase by 5°C” against the
   previewed baseline; reject stale application instead of recomputing silently.
2. **Speak:** Send delivers a message/question/objective to a resident or selected
   group through the same serialized run boundary. It does not change world
   conditions. Show recipient scope before sending; record membership at delivery.
3. **Query:** summarize committed history without waking residents. If the user
   asks residents a fresh question, classify it as Speak, whose replies require
   real turns. A history summary and a fresh conversation have different costs.

Use a constrained parser, optionally backed by a model, with a schema and the
target run's capability list. Validate the result server-side. A keyword like
“heat” must not cause the question “How do you feel about the heat?” to mutate
temperature. Reuse existing pack/corridor IDs; resolve districts through the
current area definitions, whose boundaries are geometric approximations.
The parser has no authority to execute tools, create residents or write money.

Clear supported commands need no conversational clarification beyond their
normal preview. For genuinely missing information, request only what matters:
target object/area, units, duration, or which tax. Distinguish a 2-percentage-point
increase from a 2% relative increase. “Heat this building” is unsupported until
buildings have a declared thermal property; do not silently heat the whole city.
Mixed “change X and tell group Y” prompts produce linked operations, with the
announcement contingent on a successful change and its actual committed value.

An apply/send endpoint consumes the proposal ID, expected revision and an
idempotency key. Reuse the companion's durable journal and receipts so the same
operation cannot apply once from a menu and again through a parser retry. Store
proposal/command IDs on events, messages, resident decisions and summary evidence.
No prompt can accidentally target the background live session while a native
run or saved recording is displayed. A recording supports historical queries;
it cannot receive new world changes or resident conversations.

## Direct swarm communication uses the actual resident sessions

Start with groups resolved from explicit roster selection or existing profile
roles, such as couriers. Assign a stable group ID/membership revision to the
selection; resolve and persist recipient IDs against the target run. Roles need
not be made into a new coordinator swarm. Arbitrary “rescue teams” cannot be
invented when the run contains no such residents or capabilities.

Add `OperatorMessage` and `ResidentReply` records with conversation/command IDs,
typed sender/recipient, sent/delivered times and causal/evidence references.
Operator identity is explicit: do not spoof a resident or broaden the normal
resident contacts list to accept arbitrary external identities. A resident can
reply only to a conversation delivered to them, through a scoped reply variant
of the existing message proposal. Preserve the one-message-per-turn limit;
a reply and a neighbor warning compete for that slot instead of bypassing it.

Delivery schedules each recipient's own persistent JiuwenSwarm session using
their local knowledge, plans and tasks. It does not share private prompts or
all group members' memories with a central model. Each response is recorded as
accepted speech, and each requested physical action remains a separate validated
proposal. “Move away” can be declined or fail; its success comes from measured
movement, not an acknowledgment. Group questions have a bounded response window
and concurrency budget; show pending, answered and unavailable counts.

Further resident-to-resident discussion continues through the existing contact
or proposed nearby-message channel. Cross-group communication needs eligible
recipients; addressing a group does not reveal all its members' private state.

## Temperature, weather and policy are first-class changes

Give the native world versioned environment and policy state. They emit local
observations/announcements through the same event layer as hazards, without
pretending every event is a circular road restriction.

**Temperature and rain.** Initially support citywide ambient temperature with
explicit Celsius values in the existing -40°C to 50°C range. Local temperature
fields require a subsequent area-exposure policy; reject unsupported local
scope rather than treating “here” as citywide. Rain can use a supported area
footprint and duration with an explicitly qualitative observation effect.
Deliver environment observations on entry or meaningful change, coalescing
small updates to avoid a paid turn on every tick.

Current `temperature_response` models cold only: values above 20°C do not
decrease walking speed or tolerance, despite heat wording in City log. Native
residents can learn about 35°C and choose existing supported activities, but
that does not establish physiological heat stress. Port and version any
deterministic environment-to-mobility effects explicitly; do not infer a
physical penalty from a summary or fabricate shade, water, or indoor cooling
capabilities. Tornado/rain authoring must identify observable versus simulated
effects and route through the native event journal; visual state is not authority.

**Taxes.** There is no tax or household finance model in the inspected native
contracts. Add a minimal declared policy record: policy ID/type, jurisdiction,
rate/unit, explicit applicability, current version, baseline and effective time.
The run configuration supplies a baseline, or the operator first declares one;
there is no hidden default rate. A revision does not change disposable income
unless a separate economic model actually calculates and records that effect.

For the first implementation, a tax change means an authoritative policy fact
and a delivered announcement. Affected subscribers may form opinions, send
complaints, discuss it, or revise supported commitments. Announce to actual
resident IDs via a recorded policy subscription; if the demo uses all residents,
declare that choice. Others can learn through ordinary messages. No automatic
“everyone is angry” response or generic citywide mood decrement.

Add a scoped `feedback` destination within the same message contract so a
resident can proactively complain to City Hall even without a prior operator
question. Validate that the feedback references a policy/event the resident has
learned. This is accepted speech, not a tax repeal or an economic outcome.
Persist beliefs, feedback and subsequent actions with their native decision
provenance. Neither a complaint nor silence proves financial hardship or consent.

## Natural-language summaries close the conversation loop

Extend the current City log/conversation UI with distinct records for applied
changes, delivery, attributed resident replies, decisions and observed outcomes.
Render direct replies verbatim from the accepted public message record. An
optional aggregate summary reads only the relevant committed records at or
before the selected simulated time and links to them. Private model transcripts
are not chat replies.

The summary can say “Three of eight addressed residents replied; two raised
concerns about the tax increase” only when those records exist. Show the sample,
time window, pending/unavailable residents and provenance. Do not extrapolate
the opinion of one courier to the city or promise that all residents reacted.
Track stages separately: queued → applied/delivered → decided → accepted action
→ observed result. Distinguish an announcement from evidence it was heard and
an intended route change from actual movement.

A paid summarizer or command parser shares the application's persistent budget
accounting with resident turns and has explicit usage attribution. No hidden
provider call outside the caps, no call merely from opening a panel, and no
inference when replaying a saved summary. Persist summaries with evidence IDs,
model/source, time watermark and schema version. Basic receipts and attributed
reply lists remain useful if summarization is disabled or unavailable.

## Acceptance gates beyond the event proposal

- Menu placement and equivalent text reach the same native-run command handler;
  UI selection, weather/time/log display and playback all use that run's source.
- Parse absolute versus relative temperature, explicit scope/units, tax
  percentage points, negation and questions; ambiguous/unsupported inputs cause
  no mutation. Changed baselines invalidate stale previews.
- A valid temperature change reaches eligible native observations once; a
  forecast, preview, visual tornado, or future record does not become a fact.
- A group question reaches exactly the snapshotted residents and invokes their
  own sessions. Forged operator IDs/reply targets, undeclared groups, duplicate
  sends and out-of-run recipients are rejected.
- Residents can reply or discuss an event while moving without resetting trips.
  An unsuccessful turn records unavailability rather than invented speech.
- Tax changes persist baseline/rate/applicability and delivered announcements.
  A real complaint is attributable to a resident decision; the test must not
  demand that a live model complain or imply unimplemented financial effects.
- Summary numbers match the eligible evidence; future/private records remain
  excluded. Playback reproduces recorded messages/summaries with no inference.
- Pause/resume restores conversation membership, pending deliveries, policy and
  environment versions, relative-command receipts and budget usage exactly once.

Demonstrate temperature → direct swarm question → individual replies/decisions,
then a declared tax change → announcement → any actual discussion/feedback,
alongside the physical hazard demonstration. Run deterministic contract tests
and isolated SDK tests first. Live-native verification requires the approved
remaining model budget; mock outputs do not establish emergent behavior.

Keep main's glass UI, map assets, camera, command-bar layout and resident
inspection. Use the explicit development demo opt-out and real availability
checks. Do not redeploy or reconnect the intentionally frozen public demo as
part of this work.
