import { useEffect, useState } from 'react'
import { api } from '../api'
import { useStore, type LensTab } from '../store'
import { cohortSummaryAt, seriesAt, STATE_COLORS, type PersonState } from '../replay'
import type { Investigation } from '../types'
import { fmt } from '../util'
import Inspector from '../components/Inspector'
import ComparePanel from '../components/ComparePanel'
import PopulationLens, { PopulationMetricsPanel } from './PopulationLens'

const TABS: { id: LensTab; label: string }[] = [
  { id: 'people', label: 'People' },
  { id: 'agents', label: 'Agents' },
  { id: 'transport', label: 'Transport' },
  { id: 'diagnostics', label: 'Diagnostics' },
]

const ORDER: PersonState[] = ['not_departed', 'walking', 'waiting', 'riding', 'driving', 'arrived', 'unroutable']
const LABEL: Record<PersonState, string> = {
  not_departed: 'inside venue',
  walking: 'walking',
  waiting: 'waiting',
  riding: 'riding',
  driving: 'driving',
  arrived: 'arrived',
  unroutable: 'no route',
}

/** Swarm Lens: on-demand depth. The main view keeps only the handful of numbers in the dock. */
export default function SwarmLens() {
  const lens = useStore((s) => s.lens)
  const setLens = useStore((s) => s.setLens)
  const population = useStore((s) => s.scenarios.find((sc) => sc.scenario_id === s.scenarioId)?.scenario_kind === 'population')
  if (!lens) return null
  return (
    <aside className="drawer lens">
      <div className="drawer-head tabs">
        {TABS.map((t) => (
          <button key={t.id} className={lens === t.id ? 'on' : ''} onClick={() => setLens(t.id)}>
            {t.label}
          </button>
        ))}
        <button className="iconbtn small" onClick={() => setLens(null)} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="drawer-body">
        {population && lens !== 'diagnostics' && <PopulationLens />}
        {!population && lens === 'people' && <PeopleLens />}
        {!population && lens === 'agents' && <AgentsLens />}
        {!population && lens === 'transport' && <TransportLens />}
        {lens === 'diagnostics' && <DiagnosticsLens />}
      </div>
    </aside>
  )
}

function PeopleLens() {
  const rx = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const t = useStore((s) => s.t)
  const selection = useStore((s) => s.selection)
  const m = rx?.bundle.run.metrics
  if (!rx) return <div className="small dim">Open a completed run to see the cohort.</div>
  const sum = cohortSummaryAt(rx, t)
  const total = Object.values(sum).reduce((a, b) => a + b, 0) || 1
  return (
    <div className="lens-body">
      <div className="small dim">
        {m?.cohort_size ?? total} synthetic travelers · states read from recorded journey events at +{fmt(t)}
      </div>
      <div className="bars">
        {ORDER.map((k) => (
          <div key={k} className="bar">
            <span className="lbl">{LABEL[k]}</span>
            <span className="track">
              <i style={{ width: `${(sum[k] / total) * 100}%`, background: `rgb(${STATE_COLORS[k].join(',')})` }} />
            </span>
            <span className="val">{sum[k]}</span>
          </div>
        ))}
      </div>
      {m && (
        <div className="kv small">
          <span>completed by horizon</span>
          <b>{m.completed}</b>
          <span>median journey</span>
          <b>{m.completed_duration_median_s !== null ? fmt(m.completed_duration_median_s) : '—'}</b>
          <span>p95 journey</span>
          <b>{m.completed_duration_p95_s !== null ? fmt(m.completed_duration_p95_s) : '—'}</b>
          <span>waiting person-minutes</span>
          <b>{m.waiting_person_minutes.toFixed(0)}</b>
          <span>stranded at horizon</span>
          <b>{m.unfinished_waiting + m.unfinished_riding + m.unfinished_walking + m.unfinished_not_departed}</b>
          <span>no route (compile)</span>
          <b>{m.unroutable}</b>
        </div>
      )}
      {selection ? <Inspector /> : <div className="small dim">Click a traveler on the map for its recorded journey trace.</div>}
    </div>
  )
}

function AgentsLens() {
  const scenarioId = useStore((s) => s.scenarioId)
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const investigation = useStore((s) => s.investigation)
  const setInvestigation = useStore((s) => s.setInvestigation)
  const setError = useStore((s) => s.setError)
  const health = useStore((s) => s.health)
  const [problemText, setProblem] = useState('')
  const defaultProblem = scenario
    ? `An event at ${pack?.pack_id === 'toronto' ? 'Rogers Centre' : 'the venue'} lets out while ${scenario.restrictions[0]?.label ?? 'a corridor closure'}. The cohort needs to reach the destination zones. What service should the two shuttles run?`
    : ''
  const problem = problemText || defaultProblem
  const [constraint, setConstraint] = useState('Two extra 60-seat buses for 35 minutes. No other resources.')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!investigation || investigation.status !== 'running') return
    const id = setInterval(async () => {
      try {
        const inv = await api.investigation(investigation.investigation_id)
        setInvestigation(inv)
        if (inv.status !== 'running' && scenarioId) useStore.setState({ plans: await api.plans(scenarioId) })
      } catch (e) {
        setError(String(e))
      }
    }, 2000)
    return () => clearInterval(id)
  }, [investigation, scenarioId, setInvestigation, setError])

  const run = async () => {
    if (!scenarioId) return
    setBusy(true)
    try {
      const inv: Investigation = await api.investigate(scenarioId, problem, constraint)
      setInvestigation(inv)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lens-body">
      <div className="small dim">Bounded specialists read frozen evidence and the network, then propose plans. Every plan goes through the same validators; rejected plans stay visible as rejected.</div>
      <textarea value={problem} onChange={(e) => setProblem(e.target.value)} rows={3} />
      <textarea value={constraint} onChange={(e) => setConstraint(e.target.value)} rows={2} />
      <button className="primary" onClick={() => void run()} disabled={busy || !scenarioId || investigation?.status === 'running'}>
        {investigation?.status === 'running' ? 'Agents working…' : 'Investigate'}
      </button>
      {health && !health.providers.llm.available && <div className="small warn">No model provider is reachable; agent plans are unavailable, heuristic plans still are.</div>}
      {investigation && (
        <div className="decisions small">
          <div>
            <b>{investigation.status}</b> · {investigation.decisions.length} decisions
          </div>
          {investigation.error && <div className="bad">{investigation.error}</div>}
          {investigation.decisions.map((d) => (
            <div key={d.decision_id} className="decision">
              <span className="role">{d.role}</span> {d.action}: {d.output_summary}
              {d.validation && <div className="dim">→ {d.validation}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TransportLens() {
  const rx = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const t = useStore((s) => s.t)
  const select = useStore((s) => s.select)
  const selection = useStore((s) => s.selection)
  const pack = useStore((s) => s.pack)
  if (!rx || !scenario) return <div className="small dim">Open a completed run.</div>
  const m = rx.bundle.run.metrics
  const stops = pack?.stops.filter((s) => scenario.constraints.allowed_stop_ids.includes(s.stop_id)) ?? []
  return (
    <div className="lens-body">
      <div className="fleet">
        {scenario.constraints.fleet.map((f) => {
          const occ = seriesAt(rx.occupancy[f.vehicle_id], t) ?? 0
          const peak = m?.max_occupancy[f.vehicle_id] ?? 0
          return (
            <button key={f.vehicle_id} className={`fleetcard ${selection?.kind === 'bus' && selection.id === f.vehicle_id ? 'on' : ''}`} onClick={() => select({ kind: 'bus', id: f.vehicle_id })}>
              <b>{f.vehicle_id.replace('_', ' ')}</b>
              <span className="track">
                <i style={{ width: `${(occ / f.capacity) * 100}%` }} />
              </span>
              <span className="small dim">
                {occ}/{f.capacity} aboard · peak {peak}
              </span>
            </button>
          )
        })}
      </div>
      <div className="small">
        <b>Stops in play</b>
        <div className="wrap">
          {stops.map((s) => (
            <button key={s.stop_id} className="tiny" onClick={() => select({ kind: 'stop', id: s.stop_id })}>
              {s.name} · {seriesAt(rx.stopQueue[s.stop_id], t) ?? 0}
            </button>
          ))}
        </div>
      </div>
      <ComparePanel />
      {selection && (selection.kind === 'bus' || selection.kind === 'stop' || selection.kind === 'restriction') && <Inspector />}
    </div>
  )
}

function DiagnosticsLens() {
  const health = useStore((s) => s.health)
  const rx = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const compare = useStore((s) => (s.compareRunId ? s.replays[s.compareRunId] : null))
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const pack = useStore((s) => s.pack)
  const mapbox = Boolean(import.meta.env.VITE_MAPBOX_TOKEN)
  const runRow = (r: NonNullable<typeof rx>, label: string) => (
    <div className="kv small mono">
      <span>{label}</span>
      <b>{r.bundle.run.run_id}</b>
      <span>plan / seed</span>
      <b>
        {r.bundle.run.plan_id} / {r.bundle.run.seed}
      </b>
      <span>engine</span>
      <b>{r.bundle.run.engine_version}</b>
      <span>manifest</span>
      <b>{r.bundle.run.manifest_hash.slice(0, 16)}</b>
      <span>tracks / events</span>
      <b>
        {Object.keys(r.tracks).length} / {r.bundle.events.length}
      </b>
      <span>teleports</span>
      <b>{r.bundle.run.metrics?.teleports ?? '—'}</b>
    </div>
  )
  return (
    <div className="lens-body">
      <div className="small dim">Everything here is implementation detail: versions, hashes, providers, fallbacks, raw warnings.</div>
      {scenario?.scenario_kind === 'population' && <div className="small dim">Transit analyst configuration is separate from resident brains. The population inspector shows assigned models, actual recorded decision sources, and native framework mappings.</div>}
      <div className="kv small mono">
        <span>schema</span>
        <b>{health?.schema_version ?? '—'}</b>
        <span>SUMO</span>
        <b>{health?.sumo ?? '—'}</b>
        <span>transit analyst model</span>
        <b>
          {health ? `${health.providers.llm.model} via ${health.providers.llm.provider}${health.providers.llm.sponsor ? '' : ' (local fallback)'}` : '—'}
          {health && !health.providers.llm.available ? ' · unavailable' : ''}
        </b>
        <span>evidence</span>
        <b>{health ? (health.providers.evidence.available ? health.providers.evidence.provider : 'unavailable') : '—'}</b>
        <span>sentry</span>
        <b>{health?.providers.sentry.enabled ? 'enabled' : 'disabled (no DSN)'}</b>
        <span>share</span>
        <b>{health ? `${health.providers.share.mode}${health.providers.share.r2_configured ? ' (R2)' : ' (local export)'}` : '—'}</b>
        <span>basemap</span>
        <b>{mapbox ? 'Mapbox Standard (3D)' : 'MapLibre + OpenFreeMap (fallback)'}</b>
        <span>network</span>
        <b>{pack ? `${pack.pack_id} · ${pack.network_fingerprint}` : '—'}</b>
        <span>scenario</span>
        <b>{scenario?.scenario_id ?? '—'}</b>
        <span>evidence bundle</span>
        <b>{scenario ? `${scenario.evidence_bundle_id ?? 'none'} ${scenario.evidence_hash ? scenario.evidence_hash.slice(0, 12) : ''}` : '—'}</b>
      </div>
      {rx && runRow(rx, 'view run')}
      {rx?.population?.artifact && <PopulationMetricsPanel metrics={rx.population.artifact.metrics} status={rx.bundle.run.status} />}
      {rx?.bundle.run.run_kind === 'population' && !rx.population && <div className="warn small">Population artifact absent; no mental state, ownership, or native provenance can be inferred from tracks alone.</div>}
      {compare && runRow(compare, 'compare run')}
      {rx && (
        <details className="small">
          <summary>run warnings ({rx.bundle.run.warnings.length})</summary>
          {rx.bundle.run.warnings.map((w, i) => (
            <div key={i} className={w.startsWith('RESTRICTION') ? 'bad' : ''}>
              {w}
            </div>
          ))}
        </details>
      )}
      {pack && pack.limitations.length > 0 && (
        <details className="small">
          <summary>city pack limitations ({pack.limitations.length})</summary>
          {pack.limitations.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </details>
      )}
    </div>
  )
}
