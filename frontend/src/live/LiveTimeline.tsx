import type { LiveController, LiveViewState } from './controller'
import { elapsed, interventionLabel } from './timeline'

export default function LiveTimeline({ controller, view }: { controller: LiveController; view: LiveViewState }) {
  const state = view.primary?.state
  const counts = view.primary?.replay.frameAt(view.t)?.counts
  const baseline = view.baseline?.replay.frameAt(view.t)?.counts
  const end = controller.recordedUntil()
  const active = counts ? counts.walking + counts.waiting + counts.riding + counts.driving : null
  return <section className="live-timeline" aria-label="Simulation timeline">
    <div className="live-summary">
      <div className="live-clock"><span className="live-eyebrow">{view.followLive ? 'Live playhead' : 'Recorded history'}</span><strong>+{elapsed(view.t)}</strong></div>
      <div className="live-count"><strong>{counts?.total.toLocaleString() ?? '—'}</strong><span>Travelers</span></div>
      <div className="live-count"><strong>{active?.toLocaleString() ?? '—'}</strong><span>Active in SUMO</span></div>
      <div className="live-count waiting"><strong>{counts?.waiting.toLocaleString() ?? '—'}</strong><span>Waiting</span></div>
      <div className="live-count riding"><strong>{counts?.riding.toLocaleString() ?? '—'}</strong><span>On transit</span></div>
      <div className="live-count"><strong>{counts?.arrived.toLocaleString() ?? '—'}</strong><span>Arrived</span></div>
      <div className="live-count live-secondary-count"><strong>{counts?.not_departed.toLocaleString() ?? '—'}</strong><span>Not departed</span></div>
      <div className="live-count live-secondary-count"><strong>{counts?.unroutable.toLocaleString() ?? '—'}</strong><span>Unroutable</span></div>
      {baseline && <div className="live-baseline-count">Original: <b>{baseline.arrived.toLocaleString()}</b> arrived / {baseline.total.toLocaleString()}</div>}
    </div>
    <div className="live-scrub">
      <input type="range" min={0} max={Math.max(1, end)} step={1} value={Math.min(end, Math.floor(view.t))} disabled={!state || end === 0 || !!view.busy} aria-label="Recorded simulation time" aria-valuetext={`Plus ${elapsed(view.t)}, recorded through ${elapsed(end)}`} onPointerDown={() => controller.beginScrub()} onKeyDown={e => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) controller.beginScrub() }} onChange={e => void controller.seek(Number(e.target.value))} />
      <div className="live-event-markers">{state?.commands.filter(command => command.at_s <= end).map(command => <button key={command.command_id} className={`live-event-marker ${command.intervention.kind}`} style={{ left: `${Math.min(100, command.at_s / Math.max(1, end) * 100)}%` }} title={`+${elapsed(command.at_s)} · ${interventionLabel(command.intervention)}`} aria-label={`Seek to ${interventionLabel(command.intervention)}`} onClick={() => { controller.beginScrub(); void controller.seek(command.at_s) }} />)}</div>
    </div>
    <div className="live-playback-row">
      <div className="live-playback-actions">
        <button className="ghostbtn" disabled={!state || !!view.busy} onClick={() => { controller.beginScrub(); void controller.seek(Math.max(0, view.t - 10)) }}>−10s</button>
        <button className="primary live-play" disabled={!state || !!view.busy} onClick={() => controller.toggle()} aria-label={view.playing ? 'Pause simulation' : 'Play simulation'}>{view.playing ? 'Pause' : 'Play'}</button>
        <label className="live-speed">Speed<select value={controller.clock.speed} onChange={e => controller.setSpeed(Number(e.target.value))}>{[1, 5, 10, 20].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
        <button className="ghostbtn" disabled={!state || !!view.busy} onClick={() => void controller.liveEdge()}>Go live</button>
      </div>
      <span className="live-recorded-status">{view.loading ? 'Loading recorded time' : view.buffering ? 'Waiting for measured frames' : `Recorded through +${elapsed(end)}`}<span> · Future time is not animated</span></span>
      <span className="live-key-hint">Space to play / pause</span>
    </div>
  </section>
}
