import { useState } from 'react'
import { brainColor, residentViewAt, type PopulationIndex } from '../population'
import type { SocietyTask, SwarmBinding } from '../types'
import { fmt } from '../util'

export default function ResidentInspector({ population, residentId, t, onSelect, onClose }: {
  population: PopulationIndex
  residentId: string
  t: number
  onSelect: (id: string) => void
  onClose: () => void
}) {
  const [taskId, setTaskId] = useState<string | null>(null)
  const view = residentViewAt(population, residentId, t)
  if (!view) return <div className="small dim">Resident definition is unavailable.</div>
  const { profile, state, assignment, decision, provenance, binding } = view
  const color = `rgb(${brainColor(assignment).join(',')})`
  const anchor = binding?.anchor_id ? population.anchors[binding.anchor_id] : state?.anchor_id ? population.anchors[state.anchor_id] : null
  const tasks = taskId ? view.tasks.filter((task) => task.task_id === taskId) : view.tasks
  const contact = (id: string) => population.profiles[id]
    ? <button key={id} className="tiny" onClick={() => onSelect(id)}>{population.profiles[id].name}</button>
    : <span key={id}>{id}</span>
  const mapping = (b: SwarmBinding, key: string) => <div className="population-record mono" key={key}>
    <div>{b.bound_s === undefined ? 'Timing unavailable (run-level record)' : `bound +${fmt(b.bound_s)}`} · generation {b.generation} · {b.restored ? 'restored' : 'not restored'}</div>
    <div>JiuwenSwarm team {b.team_id}</div><div>workflow {b.workflow_id}</div><div>session {b.session_id}</div><div>worker {b.worker_id}</div>
    <div>requested {b.requested_model_id}</div><div>resolved {b.resolved_model_id}</div>
  </div>
  const taskCard = (task: SocietyTask) => (
    <div className="population-record" key={task.task_id}>
      <b>{task.task_id}</b> · {task.kind} · <b>{task.status}</b>
      {![task.requester_id, task.provider_id, task.assignee_id].includes(residentId) && <div className="dim">Available on the role-scoped task board; not this resident's accepted commitment.</div>}
      <div>{population.anchors[task.service_anchor_id]?.name ?? task.service_anchor_id} → {population.anchors[task.destination_anchor_id]?.name ?? task.destination_anchor_id}</div>
      <div>requested +{fmt(task.created_s)} · due +{fmt(task.deadline_s)} · capacity {task.required_capacity}</div>
      <div className="wrap">requester {contact(task.requester_id)} {task.provider_id && <>provider {contact(task.provider_id)}</>} {task.assignee_id && <>assignee {contact(task.assignee_id)}</>}</div>
      {task.ready_s !== null && <div>ready +{fmt(task.ready_s)}</div>}
      {task.completed_s !== null && <div>completed +{fmt(task.completed_s)}</div>}
      {task.failure_reason && <div className="warn">{task.failure_reason}</div>}
      {task.declined_by.length > 0 && <div className="wrap">declined by {task.declined_by.map(contact)}</div>}
    </div>
  )
  return (
    <div className="inspector resident-inspector small">
      <div className="row between">
        <h2><i className="brain-dot" style={{ background: color }} />{profile.name}</h2>
        <button className="tiny" onClick={onClose}>Close</button>
      </div>
      <div className="dim">{profile.resident_id} · synthetic resident · {population.artifact ? `recorded at +${fmt(t)}` : 'initial definition, not executed'}</div>
      <p>{profile.persona}</p>
      <div className="wrap">{profile.roles.map((role) => <span className="pill" key={role}>{role.replaceAll('_', ' ')}</span>)}</div>
      <div><b>{state?.activity ?? 'no state yet'}</b> · role {state?.role.replaceAll('_', ' ') ?? '—'} · mode {binding?.mode ?? state?.mobility_mode ?? '—'}{binding?.vehicle_class ? ` · ${binding.vehicle_class}` : ''}</div>
      <div className="dim">
        {binding?.ownership === 'abstract' ? `Abstract stationary presence at ${anchor?.name ?? binding.anchor_id}; not measured movement or an interior position.`
          : binding?.ownership === 'shared' ? `Aboard shared vehicle ${binding.entity_id}; passenger identity does not color the vehicle.`
            : binding?.measured ? `Measured mobility binding: ${binding.entity_id}` : 'No measured or abstract presence binding at this time.'}
      </div>
      {state?.destination_id && <div>intended destination: {population.anchors[state.destination_id]?.name ?? state.destination_id}</div>}
      <details>
        <summary>Preferences and responsibilities</summary>
        {Object.entries(profile.preferences).map(([key, value]) => <div key={key}>{key}: {value}</div>)}
        <div>home: {population.anchors[profile.home_anchor_id]?.name ?? profile.home_anchor_id}</div>
        {profile.work_anchor_id && <div>work: {population.anchors[profile.work_anchor_id]?.name ?? profile.work_anchor_id}</div>}
        <div>classes: {profile.available_classes.join(', ')} · carrying capacity {profile.carrying_capacity}</div>
        <div>household {profile.household_id}{profile.organization_id ? ` · organization ${profile.organization_id}` : ''}</div>
        {profile.routine.map((step, i) => <div key={i}>{step.activity} at {population.anchors[step.anchor_id]?.name ?? step.anchor_id}, earliest +{fmt(step.earliest_s)} for {fmt(step.duration_s)} (declared routine)</div>)}
      </details>
      <section>
        <h2>Needs and commitments</h2>
        <div className="wrap">{Object.entries(state?.needs ?? {}).map(([key, value]) => <span className="pill" key={key}>{key}: {value.toFixed(2)}</span>)}</div>
        <div className="wrap">
          {(state?.commitments ?? []).map((id) => <button className="tiny" key={id} onClick={() => setTaskId(id)}>{id}{state?.current_task_id === id ? ' · current' : ''}</button>)}
          {!state?.commitments.length && <span className="dim">No recorded commitments at this time.</span>}
        </div>
        {state?.current_task_id && !state.commitments.includes(state.current_task_id) && <button className="tiny" onClick={() => setTaskId(state.current_task_id)}>current task: {state.current_task_id}</button>}
      </section>
      <section>
        <h2>Relevant task ledger · 32 most recent</h2>
        {taskId && <button className="tiny" onClick={() => setTaskId(null)}>All relevant tasks</button>}
        {tasks.map(taskCard)}
        {tasks.length === 0 && <div className="dim">No matching task recorded by this time.</div>}
      </section>
      <section>
        <h2>Current recorded plan</h2>
        {(state?.plan ?? []).length ? <ol>{state!.plan.map((step, i) => <li key={i}>{step}</li>)}</ol> : <div className="dim">No current plan recorded.</div>}
        <h2>Beliefs, not authoritative facts</h2>
        {(state?.beliefs ?? []).map((belief, i) => <div key={i}>{belief}</div>)}
        {!state?.beliefs.length && <div className="dim">No beliefs recorded in this state.</div>}
      </section>
      <section>
        <h2>Contacts and relationships</h2>
        <div className="wrap">{profile.contacts.map((id) => <span key={id}>{contact(id)}{state?.relationships[id] !== undefined && ` ${state.relationships[id].toFixed(2)}`}</span>)}</div>
        {Object.keys(state?.relationships ?? {}).filter((id) => !profile.contacts.includes(id)).map((id) => <div key={id}>{contact(id)} · {state!.relationships[id].toFixed(2)}</div>)}
      </section>
      <section>
        <h2>Assigned brain</h2>
        <div><i className="brain-dot" style={{ background: color }} />{provenance.assignedFamily ?? 'unassigned'} · {provenance.assignedModel ?? '—'}</div>
        <div className="dim">API provider {provenance.apiProvider ?? '—'} · control {provenance.controlMode ?? '—'}</div>
        <h2>Actual latest decision</h2>
        <div>source: <b>{provenance.source === 'none' ? 'none recorded yet' : provenance.source}</b> · actual model: <b>{provenance.actualModel ?? 'none recorded'}</b></div>
        {decision && <div>decision +{fmt(decision.t)} · epoch {decision.epoch}</div>}
        {provenance.fallbackReason && <div className="warn">Fallback: {provenance.fallbackReason}</div>}
        {state?.fallback_reason && state.fallback_reason !== provenance.fallbackReason && <div className="warn">State fallback: {state.fallback_reason}</div>}
        <div className="dim">Replay only. Recorded summaries and simulated beliefs are not hidden model reasoning. Inspection does not call a model.</div>
      </section>
      <section>
        <h2>{decision?.source === 'jiuwenswarm' ? 'Recorded generated summary' : 'Recorded decision summary'}</h2>
        <div>{decision?.summary || 'No decision summary recorded by this time.'}</div>
        <h2>Proposal</h2>
        {decision?.proposal ? <div>{decision.proposal.action} {decision.proposal.target_id ?? ''}{decision.proposal.travel_class ? ` via ${decision.proposal.travel_class}` : ''} · effective +{fmt(decision.proposal.effective_t)}<div className="dim">{decision.proposal.text}</div></div> : <div className="dim">No proposal recorded.</div>}
        <h2>Authority acceptance</h2>
        <div>{decision ? decision.accepted ? 'Accepted action' : 'Not accepted' : 'No validation recorded'}{decision?.reason ? ` · ${decision.reason}` : ''}</div>
        {decision?.plan.length ? <details><summary>Plan proposed with this decision</summary>{decision.plan.map((step, i) => <div key={i}>{step}</div>)}</details> : null}
        {decision?.beliefs.length ? <details><summary>Beliefs recorded with this decision</summary>{decision.beliefs.map((belief, i) => <div key={i}>{belief}</div>)}</details> : null}
        {view.events.some((event) => event.status === 'committed') && <>
          <h2>Committed world transitions by selected time</h2>
          {view.events.filter((event) => event.status === 'committed').map((event) => <div className="population-record" key={event.event_id}>+{fmt(event.t)} · {event.text}<div className="dim">authority committed · cause {event.cause_id ?? 'not recorded'}</div></div>)}
        </>}
        <h2>Observed outcomes by selected time</h2>
        {view.outcomes.map((event) => <div className="population-record" key={event.event_id}>+{fmt(event.t)} · {event.text}<div className="dim">observed · cause {event.cause_id ?? 'not recorded'}</div></div>)}
        {view.outcomes.length === 0 && <div className="dim">No observed outcome recorded yet. Acceptance alone is not completion.</div>}
      </section>
      <details>
        <summary>Decision history ({view.decisions.length} recent)</summary>
        {[...view.decisions].reverse().map((d) => <div className="population-record" key={d.decision_id}>+{fmt(d.t)} · {d.source} · {d.actual_model_id ?? 'no actual model'}<div>{d.summary}</div><div>{d.proposal?.action ?? 'no proposal'} · {d.accepted ? 'accepted' : 'not accepted'} · {d.reason}</div>{d.fallback_reason && <div className="warn">{d.fallback_reason}</div>}</div>)}
      </details>
      <details open>
        <summary>Observations and memories ({state?.memories.length ?? 0})</summary>
        {[...(state?.memories ?? [])].reverse().map((memory) => <div className="population-record" key={`${memory.event_id}-${memory.kind}`}>+{fmt(memory.t)} · <b>{memory.kind === 'belief' ? 'belief, not fact' : memory.kind}</b><div>{memory.text}</div><div className="wrap">{memory.related_residents.map(contact)}</div></div>)}
      </details>
      <details open>
        <summary>Recorded messages</summary>
        {view.receivedMessages.map((message) => <div className="population-record" key={`received-${message.message_id}`}>received +{fmt(message.delivered_s!)} from {contact(message.sender_id)}<div>{message.text}</div></div>)}
        {view.sentMessages.map((message) => <div className="population-record" key={`sent-${message.message_id}`}>sent +{fmt(message.sent_s)} to {contact(message.recipient_id)}<div>{message.text}</div><div className="dim">{message.delivered_s === null ? 'not delivered by selected time' : `delivered +${fmt(message.delivered_s)}`}</div></div>)}
        {!view.sentMessages.length && !view.receivedMessages.length && <div className="dim">No sent or delivered messages by selected time.</div>}
      </details>
      <details>
        <summary>World event ledger ({view.events.length} recent)</summary>
        {view.events.map((event) => <div className="population-record" key={event.event_id}>+{fmt(event.t)} · <b>{event.status}</b> · {event.kind}<div>{event.text}</div><div className="dim">{event.event_id} · cause {event.cause_id ?? '—'}</div></div>)}
      </details>
      <details>
        <summary>Recorded framework provenance</summary>
        <div className="dim">Mappings do not establish that any particular turn used a model; see actual decision source above. Private checkpoint contexts are not exposed here.</div>
        {view.swarmBinding ? <><b>Latest mapping at selected time</b>{mapping(view.swarmBinding, 'latest')}</> : <div className="dim">No timestamped native mapping recorded by this time.</div>}
        {view.swarmBindings.length > 1 && <details><summary>Earlier mappings through selected time</summary>{view.swarmBindings.filter((b) => b !== view.swarmBinding).map((b, i) => mapping(b, `timed-${b.session_id}-${b.generation}-${i}`))}</details>}
        {view.legacySwarmBindings.length > 0 && <details>
          <summary>Legacy run-level mappings (timing unavailable)</summary>
          <div className="dim">Run-level mappings, not timestamped worker history. No activation time is inferred for these older records.</div>
          {view.legacySwarmBindings.map((b, i) => mapping(b, `legacy-${b.session_id}-${b.generation}-${i}`))}
        </details>}
      </details>
    </div>
  )
}
