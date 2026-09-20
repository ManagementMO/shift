import { usePopulationStimuli } from '../populationStimuli'
import { useStore } from '../store'
import { fmt } from '../util'

export default function PopulationEvents() {
  const pending = usePopulationStimuli(s => s.pending)
  const notice = usePopulationStimuli(s => s.notice)
  const replay = useStore(s => s.primaryRunId ? s.replays[s.primaryRunId] : null)
  const t = useStore(s => s.t)
  const applied = replay?.population?.artifact?.stimuli?.filter(s => s.applied_s <= t) ?? []
  return <details open={!!notice || pending.length > 0} className="population-run small" aria-label="Swarm event inbox">
    <summary>Events and messages{pending.length ? ` · ${pending.length} queued` : ""}</summary>
    <p>Place an event from Events, or use the prompt to address the swarm. Nearby residents receive warnings; their own models choose actions and messages.</p>
    <p className="dim">Warnings affect resident observations. They do not yet close native transport routes or simulate injuries.</p>
    {notice && <p role="status">{notice}</p>}
    {pending.length > 0 && <><p>{pending.length} event(s) waiting for a new run.</p><button className="ghostbtn" onClick={() => usePopulationStimuli.getState().clearPending()}>Clear pending events</button></>}
    {applied.slice(-5).map(({ stimulus, applied_s, resident_ids }) => <div key={stimulus.stimulus_id} className="population-record">
      <b>+{fmt(applied_s)} · {stimulus.kind}</b><div>{stimulus.text}</div><div className="dim">Observed by {resident_ids.length} resident(s)</div>
    </div>)}
  </details>
}
