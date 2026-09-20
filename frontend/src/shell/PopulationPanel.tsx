import { useEffect, useState } from 'react'
import { defaultPopulationSpec, populationCostLimit, populationScaleReason, populationUnavailableReason } from '../populationControls'
import { useStore } from '../store'
import { clock, PLAYBACK_SPEEDS } from '../world/playback'
import { fmt } from '../util'
import PopulationLens from './PopulationLens'
import PopulationRunActions from './PopulationRunActions'
import PopulationRunControl from './PopulationRunControl'
import './population.css'

export default function PopulationPanel() {
  const pack = useStore(s => s.pack)
  const status = useStore(s => s.populationStatus)
  const statusError = useStore(s => s.populationStatusError)
  const active = useStore(s => s.populationActive)
  const scenarios = useStore(s => s.scenarios)
  const scenarioId = useStore(s => s.scenarioId)
  const definition = useStore(s => s.populationDefinition)
  const runs = useStore(s => s.runs)
  const busy = useStore(s => s.populationSubmitting || !!s.building)
  const replay = useStore(s => s.primaryRunId ? s.replays[s.primaryRunId] ?? null : null)
  const t = useStore(s => s.t)
  const playing = useStore(s => s.playing)
  const speed = useStore(s => s.speed)
  const error = useStore(s => s.error)
  const [count, setCount] = useState(12)
  const [seed, setSeed] = useState(7)
  const [horizon, setHorizon] = useState(3600)
  const refreshStatus = useStore(s => s.refreshPopulationStatus)
  const refreshPopulations = useStore(s => s.refreshPopulations)
  const unavailable = populationUnavailableReason(status, statusError)
  const gate = populationScaleReason(status, count)

  useEffect(() => { void refreshStatus(); void refreshPopulations() }, [refreshStatus, refreshPopulations])

  const create = () => {
    if (!status || !pack) return
    void useStore.getState().createPopulation(defaultPopulationSpec(status, { count, seed, horizon, packId: pack.pack_id }))
  }
  const saved = scenarios.filter(s => s.scenario_kind === 'population' && s.pack_id === pack?.pack_id)

  return <div className="tool population-panel">
    <div className="population-heading"><strong>JiuwenSwarm residents</strong><span className={`population-status ${unavailable ? 'unavailable' : 'available'}`}>{unavailable ? 'Not ready' : 'Runtime configured'}</span></div>
    <p className="small dim">Persistent people with individual model sessions, needs, tasks, contacts, and measured SUMO journeys. This is distinct from the rule-driven street traffic.</p>
    {unavailable && <div className="small warn" role="status">{unavailable}</div>}
    <div className="small dim">Inference budget remaining: ${populationCostLimit(status).toFixed(2)}. Loading saved records never invokes models.</div>
    <button className="ghostbtn" onClick={() => void refreshStatus()} disabled={busy}>Check native connection</button>
    <label>Saved population<select aria-label="Saved native population" value={active ? scenarioId ?? '' : ''} disabled={busy} onChange={e => { if (e.target.value) void useStore.getState().selectScenario(e.target.value) }}><option value="">Choose saved residents</option>{saved.map(s => <option key={s.scenario_id} value={s.scenario_id}>{s.label}</option>)}</select></label>
    <details open={!definition} className="population-create"><summary>Define a population</summary>
      <label>Residents<input type="number" min={5} max={300} value={count} onChange={e => setCount(Number(e.target.value))} /></label>
      <label>Seed<input type="number" min={0} step={1} value={seed} onChange={e => setSeed(Number(e.target.value))} /></label>
      <label>Duration<select value={horizon} onChange={e => setHorizon(Number(e.target.value))}><option value={600}>10 simulated minutes</option><option value={1800}>30 simulated minutes</option><option value={3600}>One simulated hour</option></select></label>
      {gate && <p className="small warn">{gate}</p>}
      <button className="primary" onClick={create} disabled={!!unavailable || busy || !Number.isInteger(count) || count < 5 || count > 300 || !Number.isSafeInteger(seed)}>Define residents (no model calls)</button>
    </details>
    {active && definition && <PopulationRunControl />}
    {active && <div className="population-runs">{runs.map(run => <section key={run.run_id} className="population-run-record">
      <div className="row between"><b>{run.status}</b><span className="mono">{run.run_id.slice(-8)}</span></div>
      <div className="small dim">{Math.round(run.progress * 100)}% simulated{run.error ? ` · ${run.error}` : ''}</div>
      <button className="ghostbtn" disabled={busy} onClick={() => void useStore.getState().openRun(run.run_id, 'primary', true)}>View saved movement and decisions</button>
      <PopulationRunActions run={run} />
    </section>)}</div>}
    {active && replay && <section className="population-playback" aria-label="Resident recorded history">
      <div className="row between"><strong>Recorded +{fmt(t)}</strong><span className="small dim">through +{fmt(replay.tMax)}</span></div>
      <label>Inspect recorded time<input type="range" aria-label="Resident recorded time" min={0} max={Math.max(1, replay.tMax)} step={1} value={Math.min(t, replay.tMax)} onChange={e => { clock.pause(); clock.seek(Number(e.target.value)) }} /></label>
      <div className="row"><button className="ghostbtn" onClick={() => clock.toggle()}>{playing ? 'Pause playback' : 'Play recording'}</button><select aria-label="Resident playback speed" value={speed} onChange={e => clock.setSpeed(Number(e.target.value))}>{PLAYBACK_SPEEDS.map(value => <option key={value} value={value}>{value}×</option>)}</select></div>
      <p className="small dim">Playback only. Execution pause and resume are separate controls above.</p>
    </section>}
    {active && <PopulationLens />}
    {error && <div className="small bad" role="alert">{error}</div>}
    {active && <button className="ghostbtn" onClick={() => void useStore.getState().leavePopulation()} disabled={busy}>Return to street simulation</button>}
  </div>
}
