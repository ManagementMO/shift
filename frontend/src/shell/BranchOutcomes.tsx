import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { comparePopulations, type PopulationSummary } from '../comparison'
import { useStore } from '../store'
import type { RunBundle } from '../types'
import { fmt } from '../util'

function Population({ label, summary }: { label: string; summary: PopulationSummary }) {
  return <div className="population-summary small">
    <b>{label}</b>
    <div>completed {summary.completed}/{summary.size} · unfinished {summary.unfinished}/{summary.size} · unroutable {summary.unroutable}/{summary.size}</div>
    <div className="dim">waiting person-min: {summary.waitingPersonMinutes === null ? 'unavailable' : summary.waitingPersonMinutes.toFixed(1)} · completed-only median: {summary.durationMedianS === null ? '—' : fmt(summary.durationMedianS)}</div>
  </div>
}

/**
 * Before/after for a branch without a split screen: the parent scenario's latest completed run is fetched on demand
 * and matched trip-by-trip against the run being viewed. Existing trips and trips added by the branch (e.g. a new
 * building) are reported with their own denominators; the aggregate totals are never presented as an improvement.
 */
export default function BranchOutcomes() {
  const primary = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const scenarios = useStore((s) => s.scenarios)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const select = useStore((s) => s.select)
  const parentId = scenario?.parent_scenario_id ?? null
  const [parent, setParent] = useState<{ parentId: string; bundle: RunBundle | null; error: string | null } | null>(null)

  useEffect(() => {
    if (!parentId) return
    let cancelled = false
    void (async () => {
      try {
        const runs = await api.runs(parentId)
        const done = runs.filter((r) => r.status === 'completed').at(-1)
        const bundle = done ? await api.bundle(done) : null
        if (!cancelled) setParent({ parentId, bundle, error: null })
      } catch (e) {
        if (!cancelled) setParent({ parentId, bundle: null, error: String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [parentId, primary?.bundle.run.run_id])

  const diffs = useMemo(() => primary && parent?.bundle ? comparePopulations(primary.bundle, parent.bundle, scenarios) : null, [primary, parent, scenarios])
  if (!parentId || !primary) return null
  const loaded = parent?.parentId === parentId ? parent : null
  return <div className="branch-outcomes small">
    <b>Before this change · parent scenario</b>
    {!loaded && <p className="dim">Loading the parent run…</p>}
    {loaded?.error && <p className="warn">{loaded.error}</p>}
    {loaded && !loaded.error && !loaded.bundle && <p className="dim">The parent has no completed run yet; it starts automatically when the parent is opened.</p>}
    {loaded?.bundle && !diffs && <p className="warn">Saved demand metadata is unavailable; matching trips by ID alone is not valid.</p>}
    {diffs && <>
      {!diffs.related && <p className="warn">Independent demand populations. Reused IDs are not treated as the same trips.</p>}
      {!diffs.samePopulation && <p className="dim">Population differs: aggregate totals are not a matched before/after improvement.</p>}
      {!diffs.comparableHorizon && <p className="warn">Observation horizons differ. Completion totals use each run’s horizon; duration savings are not compared.</p>}
      {!diffs.sameSeed && <p className="warn">Run seeds differ; outcomes include stochastic variation.</p>}
      {diffs.changedInputs > 0 && <p className="warn">{diffs.changedInputs} reused IDs have changed trip inputs and are excluded from matching.</p>}
      {diffs.sharedIds.length > 0 && <>
        <b>Existing, unchanged trips · {diffs.sharedIds.length} matched</b>
        <Population label="Existing trips — this branch" summary={diffs.matchedView} />
        <Population label="Existing trips — parent" summary={diffs.matchedCompare} />
        {diffs.comparableHorizon && <div className="dim">arrived in both {diffs.bothArrived} · only here {diffs.onlyView} · only in parent {diffs.onlyCompare} · neither {diffs.neither}</div>}
        {diffs.medianSavedS !== null && <div>Median duration saved by this branch: {diffs.medianSavedS >= 0 ? '+' : '−'}{fmt(Math.abs(diffs.medianSavedS))} · only the {diffs.bothArrived} trips completed in both runs</div>}
        <div className="wrap">{diffs.biggest.map((r) => <button key={r.pid} className="tiny" onClick={() => select({ kind: 'person', id: r.pid })} title={`${r.pid}: here ${fmt(r.a)} vs parent ${fmt(r.b)}`}>
          {r.pid.length > 24 ? `${r.pid.slice(0, 12)}…${r.pid.slice(-8)}` : r.pid} {r.b - r.a >= 0 ? '+' : '−'}{fmt(Math.abs(r.b - r.a))}
        </button>)}</div>
      </>}
      {diffs.viewOnly.size > 0 && <Population label="Added trips — this branch only" summary={diffs.viewOnly} />}
      {diffs.compareOnly.size > 0 && <Population label="Trips only in the parent" summary={diffs.compareOnly} />}
      <p className="dim">Counts are one-way trips, not unique people across return legs. Journey medians exclude unfinished and unroutable trips.</p>
    </>}
  </div>
}
