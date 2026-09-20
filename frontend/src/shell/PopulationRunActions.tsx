import { populationScaleReason, populationUnavailableReason } from '../populationControls'
import { canPausePopulationRun, canResumePopulationRun, runIsActive, type PopulationRunAction } from '../populationLifecycle'
import { useStore } from '../store'
import type { SimulationRun } from '../types'

export function PopulationRunActionsView({ run, action, resumeReason, onPause, onResume, onStop }: {
  run: SimulationRun
  action?: PopulationRunAction
  resumeReason: string | null
  onPause: () => void
  onResume: () => void
  onStop: () => void
}) {
  if (run.run_kind !== 'population') return null
  const submitting = action?.phase === 'submitting'
  const waiting = action?.phase === 'requested'
  return <div className="population-run small">
    <div className="row wrap">
      {canPausePopulationRun(run) && <button className="ghostbtn" onClick={onPause} disabled={submitting || waiting}>Request execution pause</button>}
      {canResumePopulationRun(run) && <button className="ghostbtn" onClick={onResume} disabled={submitting || waiting || Boolean(resumeReason)}>{run.status === 'failed' ? 'Validate checkpoint & resume' : 'Resume same run'}</button>}
      {runIsActive(run) && <button className="ghostbtn" onClick={onStop} disabled={submitting || (waiting && action.action === 'stop')}>Stop (no checkpoint request)</button>}
    </div>
    {action?.phase === 'submitting' && <div className="dim">Sending execution {action.action} request…</div>}
    {action?.phase === 'requested' && <div className="warn">
      {action.action === 'pause' ? 'Pause requested, not confirmed. Waiting for the active decision boundary and a verified durable world/SUMO/private-context pair; do not stop the backend yet.'
        : action.action === 'resume' ? 'Resume acknowledged for the same run. Queued status is not proof that restoration has finished; waiting for backend execution status.'
          : 'Stop requested. This does not request a durable checkpoint and is not pause.'}
    </div>}
    {run.status === 'paused' && <div className="dim">Backend reports paused. The partial replay is read-only; resume revalidates paired hashes and versions before continuing this same simulation.</div>}
    {run.status === 'failed' && <div className="dim">Only interrupted runs with a valid paired checkpoint can resume. No checkpoint validity is exposed here; the backend may reject the request.</div>}
    {canResumePopulationRun(run) && resumeReason && <div className="warn">{resumeReason}</div>}
    {action?.phase === 'error' && <div className="bad">{action.message}</div>}
  </div>
}

export default function PopulationRunActions({ run }: { run: SimulationRun }) {
  const action = useStore((s) => s.populationActions[run.run_id])
  const status = useStore((s) => s.populationStatus)
  const statusError = useStore((s) => s.populationStatusError)
  const definition = useStore((s) => s.populationDefinition?.population_id === run.population_id ? s.populationDefinition : s.replays[run.run_id]?.population?.definition)
  const pause = useStore((s) => s.pausePopulationRun)
  const resume = useStore((s) => s.resumePopulationRun)
  const stop = useStore((s) => s.cancelRun)
  const native = !definition || definition.spec.brains.some((brain) => brain.control_mode === 'jiuwenswarm')
  const reason = native ? populationUnavailableReason(status, statusError) ?? (definition ? populationScaleReason(status, definition.spec.count) : null) : null
  return <>
    {!native && <div className="small warn">Rules fixture lifecycle only; this is not proof of native JiuwenSwarm context restoration.</div>}
    <PopulationRunActionsView run={run} action={action} resumeReason={reason} onPause={() => void pause(run.run_id)} onResume={() => void resume(run.run_id)} onStop={() => void stop(run.run_id)} />
  </>
}
