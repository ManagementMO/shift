import { useMemo, useState } from 'react'
import { brainColor, buildDefinitionIndex, populationSummaryAt, residentStateAt } from '../population'
import { useStore } from '../store'
import type { MobilityMode, PopulationMetrics, ResidentRole, RunStatus } from '../types'
import { fmt } from '../util'
import ResidentInspector from '../components/ResidentInspector'

export function PopulationMetricsPanel({ metrics, status }: { metrics: PopulationMetrics; status?: RunStatus }) {
  const final = status === 'completed'
  return <details className="small population-metrics">
    <summary>{final ? 'Whole-run population results' : 'Recorded population totals'} · recorded end +{fmt(metrics.end_time_s)}</summary>
    <div className="dim">{final ? 'Final aggregate results, not the current scrub-time state.' : 'Partial totals through the saved boundary, not a completed run or the current scrub-time state.'}</div>
    <div className="kv small">
      <span>residents / horizon</span><b>{metrics.resident_count} / {fmt(metrics.horizon_s)}</b>
      <span>completed deliveries / visits</span><b>{metrics.completed_deliveries} / {metrics.completed_visits}</b>
      <span>outstanding needs / commitments</span><b>{metrics.outstanding_needs} / {metrics.outstanding_commitments}</b>
      <span>accepted / rejected actions</span><b>{metrics.accepted_actions} / {metrics.rejected_actions}</b>
      <span>completed / failed trips</span><b>{metrics.completed_trips} / {metrics.failed_trips}</b>
      <span>memory entries / delivered messages</span><b>{metrics.memory_entries} / {metrics.delivered_messages}</b>
      <span>model calls / tokens</span><b>{metrics.calls} / {metrics.tokens.toLocaleString()}</b>
      <span>recorded cost / reserved</span><b>${metrics.cost_usd.toFixed(4)} / ${metrics.reserved_cost_usd.toFixed(4)}</b>
      <span>wall time / artifact size</span><b>{metrics.wall_time_s.toFixed(1)} s / {(metrics.artifact_bytes / 1024).toFixed(1)} KiB</b>
    </div>
    <div>Task status counts: {Object.entries(metrics.task_status_counts).map(([key, count]) => `${key} ${count}`).join(' · ') || 'none'}</div>
    <div>Actual decision sources: {Object.entries(metrics.decision_source_counts).map(([key, count]) => `${key} ${count}`).join(' · ') || 'none recorded'}</div>
    {metrics.warnings.map((warning, i) => <div className="warn" key={i}>{warning}</div>)}
  </details>
}

export default function PopulationLens() {
  const primaryRunId = useStore((s) => s.primaryRunId)
  const rx = useStore((s) => s.primaryRunId ? s.replays[s.primaryRunId] : null)
  const definition = useStore((s) => s.populationDefinition)
  const selection = useStore((s) => s.selection)
  const select = useStore((s) => s.select)
  const t = useStore((s) => s.t)
  const initial = useMemo(() => definition ? buildDefinitionIndex(definition) : null, [definition])
  const population = primaryRunId ? rx?.population ?? null : initial
  const profiles = population?.definition.profiles ?? definition?.profiles ?? []
  const [role, setRole] = useState<ResidentRole | ''>('')
  const [mode, setMode] = useState<MobilityMode | ''>('')
  const [query, setQuery] = useState('')
  const time = rx ? t : 0
  const summary = population ? populationSummaryAt(population, time) : null
  const rows = profiles.map((profile) => ({ profile, state: population ? residentStateAt(population, profile.resident_id, time) : null }))
    .filter(({ profile, state }) => (!role || state?.role === role || profile.roles.includes(role)) && (!population || !mode || state?.mobility_mode === mode) &&
      (!query || `${profile.name} ${profile.resident_id} ${profile.persona}`.toLowerCase().includes(query.toLowerCase())))
  const assignments = population?.assignments ?? definition?.assignments ?? {}
  const families = [...new Map(Object.values(assignments).map((assignment) => [assignment.model_family, assignment])).values()]
  return <div className="lens-body">
    <div className="small"><b>{profiles.length} synthetic residents</b> · {rx ? `recorded at +${fmt(t)}` : primaryRunId ? 'waiting for refreshed recorded state' : 'initial definition, not executed'}</div>
    {primaryRunId && !rx && <div className="small dim">Execution and replay are separate. The stale bundle was cleared on resume; resident selections persist while the backend reaches the next recorded boundary.</div>}
    {rx && !population && <div className="small warn">Optional population artifact is absent. Measured tracks may still replay, but mental state and ownership cannot be reconstructed.</div>}
    <div className="small dim">Persistent personas across mobility modes. Replay, selection, and scrubbing make no model calls.</div>
    <div className="wrap small">{families.map((assignment) => <span className="pill" key={assignment.model_family}><i className="brain-dot" style={{ background: `rgb(${brainColor(assignment).join(',')})` }} />{assignment.model_family}</span>)}</div>
    <div className="small dim">Color = assigned brain family, not actual decision source. Hollow rings = abstract stationary presence at declared anchors. Shared and unowned traffic stays neutral.</div>
    {summary && <div className="kv small"><span>moving / working now</span><b>{summary.moving} / {summary.working}</b><span>completed / recorded tasks now</span><b>{summary.completed} / {summary.tasks}</b><span>commitments now</span><b>{summary.commitments}</b></div>}
    <div className="row population-filters">
      <select aria-label="Resident role" value={role} onChange={(e) => setRole(e.target.value as ResidentRole | '')}>
        <option value="">All roles</option>{(['customer', 'shop_worker', 'service_worker', 'courier', 'driver'] as const).map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
      </select>
      <select aria-label="Resident mode" disabled={!population} value={mode} onChange={(e) => setMode(e.target.value as MobilityMode | '')}>
        <option value="">All modes</option>{(['stationary', 'walk', 'cycle', 'drive', 'transit'] as const).map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>
    <input aria-label="Find a resident" placeholder="Find a resident or persona" value={query} onChange={(e) => setQuery(e.target.value)} />
    <div className="list population-list" aria-label="Population residents">
      {rows.map(({ profile, state }) => <button className={`listitem ${selection?.kind === 'resident' && selection.id === profile.resident_id ? 'on' : ''}`} key={profile.resident_id} onClick={() => select({ kind: 'resident', id: profile.resident_id })}>
        <span><i className="brain-dot" style={{ background: `rgb(${brainColor(assignments[profile.resident_id]).join(',')})` }} />{profile.name}</span>
        <span className="dim">{profile.resident_id} · {state?.role.replaceAll('_', ' ') ?? profile.roles.join(', ')} · {state?.activity ?? 'state unavailable'} / {state?.mobility_mode ?? '—'}</span>
      </button>)}
      {!rows.length && <div className="small dim">No residents match these filters.</div>}
    </div>
    <div className="small dim">{rows.length} of {profiles.length} residents. All remain selectable here, including co-located residents and those with no current movement sample.</div>
    {population && selection?.kind === 'resident' ? <ResidentInspector population={population} residentId={selection.id} t={time} onSelect={id => select({ kind: 'resident', id })} onClose={() => select(null)} /> : <div className="small dim">Select a resident for persona, tasks, memories, recorded decisions, and actual framework provenance.</div>}
    {population?.artifact && <PopulationMetricsPanel metrics={population.artifact.metrics} status={rx?.bundle.run.status} />}
    {(population?.definition.assumptions ?? definition?.assumptions ?? []).length > 0 && <details className="small"><summary>Declared synthetic assumptions</summary>{(population?.definition.assumptions ?? definition?.assumptions ?? []).map((assumption, i) => <div key={i}>{assumption}</div>)}</details>}
  </div>
}
