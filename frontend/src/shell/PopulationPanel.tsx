import { useEffect, useState } from 'react'
import { defaultPopulationModelIds, defaultPopulationSpec, populationBudgetPolicy, populationCostLimit, populationCountLimit, populationDefinitionReason, populationUnavailableReason } from '../populationControls'
import { usePopulationPlayback } from '../populationLifecycle'
import { useStore } from '../store'
import { usePopulationStimuli } from '../populationStimuli'
import { clock, PLAYBACK_SPEEDS } from '../world/playback'
import { fmt } from '../util'
import PopulationLens from './PopulationLens'
import PopulationRunActions from './PopulationRunActions'
import PopulationRunControl from './PopulationRunControl'
import PopulationEvents from './PopulationEvents'
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
  const [count, setCount] = useState(100)
  const [seed, setSeed] = useState(7)
  const [horizon, setHorizon] = useState(600)
  const [maxCost, setMaxCost] = useState(5)
  const [chosenModels, setChosenModels] = useState<string[] | null>(null)
  const refreshStatus = useStore(s => s.refreshPopulationStatus)
  const refreshPopulations = useStore(s => s.refreshPopulations)
  const unavailable = populationUnavailableReason(status, statusError)
  const definitionReason = populationDefinitionReason(status, statusError)
  const maxResidents = populationCountLimit(status)
  const residentCount = Math.min(count, maxResidents)
  const modelIds = (chosenModels ?? defaultPopulationModelIds(status)).filter(id => status?.models.some(brain => brain.model_id === id))

  useEffect(() => { void refreshStatus(); void refreshPopulations() }, [refreshStatus, refreshPopulations])
  useEffect(() => { usePopulationStimuli.getState().reset(definition?.population_id ?? null) }, [definition?.population_id])

  const create = () => {
    if (!status || !pack) return
    try {
      void useStore.getState().createPopulation(defaultPopulationSpec(status, { count: residentCount, seed, horizon, packId: pack.pack_id, maxCostUsd: maxCost, modelIds }))
    } catch (error) { useStore.getState().setError(String(error)) }
  }
  const saved = scenarios.filter(s => s.scenario_kind === 'population' && s.pack_id === pack?.pack_id)

  return <div className="tool population-panel">
    <div className="population-heading"><strong>JiuwenSwarm residents</strong><span className={`population-status ${unavailable ? 'unavailable' : 'available'}`}>{unavailable ? 'Execution unavailable' : 'Runtime configured'}</span></div>
    <p className="small population-inspection-hint">Click a resident to inspect its model, decision summary, actions, and messages.</p>
    <details className="population-create"><summary>Budget and connection · ${populationCostLimit(status).toFixed(2)} remaining</summary>
    {unavailable && <div className="small warn" role="status">{unavailable}</div>}
    <div className="small dim">Inference budget remaining: ${populationCostLimit(status).toFixed(2)}. Saved residents remain inspectable when execution is unavailable. Creating a swarm and inspecting it make no model calls.</div>
    <div className="small dim">{populationBudgetPolicy(status)}</div>
    <button className="ghostbtn" onClick={() => void refreshStatus()} disabled={busy}>Check native connection</button>
    </details>
    <label>Saved population<select aria-label="Saved native population" value={active ? scenarioId ?? '' : ''} disabled={busy} onChange={e => { if (e.target.value) void useStore.getState().selectScenario(e.target.value) }}><option value="">Choose saved residents</option>{saved.map(s => <option key={s.scenario_id} value={s.scenario_id}>{s.label} · {s.scenario_id.slice(-6)}</option>)}</select></label>
    {active && definition && <PopulationEvents />}
    <details open={!definition} className="population-create"><summary>Create a native swarm</summary>
      <label>Residents<input aria-label="Native resident count" type="number" min={5} max={maxResidents} value={residentCount} onChange={e => setCount(Number(e.target.value))} /></label>
      <div className="small dim">Up to {maxResidents} native residents under the configured runtime limit. Start with a short run, then inspect individual decisions.</div>
      <label>Seed<input type="number" min={0} step={1} value={seed} onChange={e => setSeed(Number(e.target.value))} /></label>
      <label>Duration<select value={horizon} onChange={e => setHorizon(Number(e.target.value))}><option value={600}>10 simulated minutes</option><option value={1800}>30 simulated minutes</option><option value={3600}>One simulated hour</option></select></label>
      <label>Run budget (USD)<input aria-label="Run budget in USD" type="number" min={0.01} max={20} step={0.01} value={maxCost} onChange={e => setMaxCost(Number(e.target.value))} /></label>
      <div className="small dim">Effective run cap: ${Math.min(maxCost || 0, populationCostLimit(status)).toFixed(2)}. This separate per-run cap allows up to $20 and is bounded by available inference funds.</div>
      <fieldset className="population-brain-options"><legend>Resident brains · choose models</legend>{status?.models.map(brain => <label className="population-brain-option" key={brain.model_id}>
        <input type="checkbox" checked={modelIds.includes(brain.model_id)} disabled={busy || brain.control_mode !== 'jiuwenswarm'} onChange={event => setChosenModels(event.target.checked ? [...modelIds, brain.model_id] : modelIds.filter(id => id !== brain.model_id))} />
        <span><b>{brain.model_family}</b><span>{brain.model_id}</span><span className="dim">{brain.api_provider} · {brain.control_mode}</span></span>
      </label>)}</fieldset>
      <div className="small dim">Starts with one reviewed model and a $5 run cap. Each model needs room for its full context reservation before a turn starts; actual usage is charged against provider funds within this run cap. Select additional brains to distribute them across residents.</div>
      <div className="small dim">The inspector shows the actual model used for each recorded turn.</div>
      {definitionReason && <p className="small warn">{definitionReason}</p>}
      {!modelIds.length && <p className="small warn">Choose at least one native brain.</p>}
      <button className="primary" onClick={create} disabled={!!definitionReason || !modelIds.length || busy || !Number.isInteger(residentCount) || residentCount < 5 || residentCount > maxResidents || !Number.isSafeInteger(seed) || !Number.isFinite(maxCost) || maxCost <= 0 || maxCost > 20}>Create swarm (no model calls)</button>
      <div className="small dim">After creation, use Start new society run to authorize model execution within the displayed cap.</div>
    </details>
    {active && definition && <details open={!runs.length} className="population-create"><summary>Execution controls · {runs.find(r => r.run_id === useStore.getState().primaryRunId)?.status ?? "not started"}</summary><PopulationRunControl /></details>}
    {active && <PopulationLens />}
    {active && runs.length > 0 && <details className="population-create"><summary>Saved runs ({runs.length})</summary><div className="population-runs">{runs.map(run => <section key={run.run_id} className="population-run-record">
      <div className="row between"><b>{run.status}</b><span className="mono">{run.run_id.slice(-8)}</span></div>
      <div className="small dim">{Math.round(run.progress * 100)}% simulated{run.error ? ` · ${run.error}` : ''}</div>
      <div className="small dim">{run.engine_version} · seed {run.seed}</div>
      {run.warnings.map((warning, index) => <div className="small warn" key={index}>{warning}</div>)}
      <button className="ghostbtn" disabled={busy} onClick={() => void useStore.getState().openRun(run.run_id, 'primary', true)}>View saved movement and decisions</button>
      <PopulationRunActions run={run} />
    </section>)}</div></details>}
    {active && replay && <section className="population-playback" aria-label="Resident recorded history">
      <div className="row between"><strong>Recorded +{fmt(t)}</strong><span className="small dim">through +{fmt(replay.tMax)}</span></div>
      <label>Inspect recorded time<input type="range" aria-label="Resident recorded time" min={0} max={Math.max(1, replay.tMax)} step={1} value={Math.min(t, replay.tMax)} onChange={e => { usePopulationPlayback.getState().setFollowLive(false); clock.pause(); clock.seek(Number(e.target.value)) }} /></label>
      <div className="row"><button className="ghostbtn" onClick={() => { usePopulationPlayback.getState().setFollowLive(false); clock.toggle() }}>{playing ? 'Pause playback' : 'Play recording'}</button><select aria-label="Resident playback speed" value={speed} onChange={e => clock.setSpeed(Number(e.target.value))}>{PLAYBACK_SPEEDS.map(value => <option key={value} value={value}>{value}×</option>)}</select></div>
      <p className="small dim">Playback only. Execution pause and resume are separate controls above.</p>
    </section>}
    {error && <div className="small bad" role="alert">{error}</div>}
  </div>
}
