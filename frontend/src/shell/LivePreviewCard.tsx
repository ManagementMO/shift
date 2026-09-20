import { live, useLive } from '../live/session'

/**
 * The step between aiming a tool and changing the city: SUMO has validated the command and describes what it will
 * do; Apply plays it into the running simulation, Discard keeps aiming. Shared by every tool and the closure card.
 */
export default function LivePreviewCard({ applyLabel = 'Apply & play', onApplied }: { applyLabel?: string; onApplied?: () => void }) {
  const { draft, busy, error } = useLive()
  if (!draft) return null
  const apply = async () => {
    await live.apply()
    if (!live.getSnapshot().error) onApplied?.()
  }
  return (
    <div className="proposal live-preview" role="status">
      <div className="small dim">{draft.branches_history ? 'Rewinds to this moment and continues from here' : 'Applies to the running city'}</div>
      <b>{draft.title}</b>
      <div className="small">{draft.detail}</div>
      {draft.stop_names && <ol className="small">{draft.stop_names.map((name, i) => <li key={i}>{name}</li>)}</ol>}
      {draft.mobility && (
        <div className="small dim">
          walking speed ×{draft.mobility.walk_speed_factor.toFixed(2)} · walking tolerance ×{draft.mobility.walk_tolerance_factor.toFixed(2)}
        </div>
      )}
      {draft.access && draft.access.length > 0 && (
        <div className="small dim">{draft.access.map((a) => `${a.mode === 'passenger' ? 'car' : 'walking'} access ${a.distance_m.toFixed(0)} m away`).join(' · ')}</div>
      )}
      <div className="small dim">{draft.assumption}</div>
      {error && <div className="small bad">{error}</div>}
      <div className="row">
        <button className="primary" disabled={!!busy} onClick={() => void apply()}>
          {busy ? 'Applying…' : applyLabel}
        </button>
        <button className="ghostbtn" disabled={!!busy} onClick={() => live.discard()}>
          Discard
        </button>
      </div>
    </div>
  )
}
