import { useEffect, useState } from 'react'

import { api } from '../api'
import { buildIndex, type ReplayIndex } from '../replay'
import type { SimulationRun } from '../types'

export type ReplayStatus =
  | { phase: 'idle' }
  | { phase: 'loading'; run: SimulationRun }
  | { phase: 'ready'; run: SimulationRun; rx: ReplayIndex }
  | { phase: 'none' }
  | { phase: 'error'; message: string }

/** Latest completed SUMO run for `packId`, or the run named by `runId`; loads its replay bundle. */
export function useReplay(packId: string, runId: string | null): ReplayStatus {
  const [status, setStatus] = useState<ReplayStatus>({ phase: 'idle' })
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        let run: SimulationRun | undefined
        if (runId) run = await api.run(runId)
        else {
          const [scenarios, runs] = await Promise.all([api.scenarios(), api.runs()])
          const own = new Set(scenarios.filter((s) => s.pack_id === packId).map((s) => s.scenario_id))
          run = runs
            .filter((r) => r.status === 'completed' && own.has(r.scenario_id))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0]
        }
        if (!alive) return
        if (!run) return setStatus({ phase: 'none' })
        setStatus({ phase: 'loading', run })
        const bundle = await api.bundle(run)
        if (!alive) return
        setStatus({ phase: 'ready', run, rx: buildIndex(bundle) })
      } catch (e) {
        if (alive) setStatus({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      alive = false
    }
  }, [packId, runId])
  return status
}
