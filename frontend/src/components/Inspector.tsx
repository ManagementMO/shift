import { useStore } from '../store'
import { personStateAt, seriesAt } from '../replay'
import { fmt } from '../util'

function Spark({ series, max, t }: { series: { times: number[]; values: number[] } | undefined; max: number; t: number }) {
  if (!series || series.times.length < 2) return null
  const w = 260
  const h = 40
  const tMax = series.times[series.times.length - 1] || 1
  const pts = series.times.map((tt, i) => `${(tt / tMax) * w},${h - (series.values[i] / Math.max(1, max)) * h}`).join(' ')
  return (
    <svg width={w} height={h} className="spark">
      <polyline points={pts} fill="none" stroke="#4fd8ff" strokeWidth="1.5" />
      <line x1={(t / tMax) * w} x2={(t / tMax) * w} y1={0} y2={h} stroke="#fff" strokeOpacity="0.5" />
    </svg>
  )
}

export default function Inspector() {
  const selection = useStore((s) => s.selection)
  const primary = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const t = useStore((s) => s.t)
  const select = useStore((s) => s.select)
  const setT = useStore((s) => s.setT)

  if (!selection) {
    return (
      <div className="inspector">
        <h2>Inspector</h2>
        <div className="dim small">Click a bus, traveler, car, stop or closed edge. Everything shown is read from the run's stored TraCI records.</div>
        {primary && (
          <div className="small">
            <div className="dim">run {primary.bundle.run.run_id}</div>
            <div className="dim">plan {primary.bundle.run.plan_id} · seed {primary.bundle.run.seed} · {primary.bundle.run.engine_version}</div>
            <div className="dim">manifest {primary.bundle.run.manifest_hash}</div>
          </div>
        )}
      </div>
    )
  }

  if (selection.kind === 'stop') {
    const s = pack?.stops.find((x) => x.stop_id === selection.id)
    const q = primary?.stopQueue[selection.id]
    const duties = primary?.bundle.compile?.duties.filter((d) => d.stop_sequence.includes(selection.id)) ?? []
    return (
      <div className="inspector">
        <h2>Stop {s?.name ?? selection.id}</h2>
        <div className="small mono dim">
          {selection.id} · edge {s?.edge_id} lane {s?.lane_index} · {s?.lon.toFixed(5)}, {s?.lat.toFixed(5)}
        </div>
        <div className="small">waiting now: {seriesAt(q, t) ?? 0}</div>
        <Spark series={q} max={Math.max(1, ...(q?.values ?? [1]))} t={t} />
        {duties.length > 0 && (
          <div className="small">
            <b>served by</b>
            {duties.map((d) => (
              <div key={d.duty_id} className="mono">
                {d.vehicle_id} {d.duty_id} dep {fmt(d.depart_s)}
              </div>
            ))}
          </div>
        )}
        <button onClick={() => select(null)}>close</button>
      </div>
    )
  }

  if (selection.kind === 'restriction') {
    const r = scenario?.restrictions.find((x) => x.restriction_id === selection.id) ?? scenario?.restrictions[0]
    return (
      <div className="inspector">
        <h2>Restriction</h2>
        {r && (
          <div className="small">
            <div>{r.label}</div>
            <div className="dim">
              {r.edge_ids.length} edges · modes {r.modes.join(', ')} · {fmt(r.start_s)}–{fmt(r.end_s)}
            </div>
            <div className="dim">source claim: {r.source_claim_id ?? 'scenario fixture (no evidence claim attached)'}</div>
            {primary?.bundle.run.metrics?.warnings.filter((w) => w.toLowerCase().includes('restriction integrity')).map((w, i) => (
              <div key={i} className={w.startsWith('RESTRICTION') ? 'bad' : 'ok'}>
                {w}
              </div>
            ))}
          </div>
        )}
        <button onClick={() => select(null)}>close</button>
      </div>
    )
  }

  if (!primary) return null

  if (selection.kind === 'bus') {
    const occ = primary.occupancy[selection.id]
    const cap = scenario?.constraints.fleet.find((f) => f.vehicle_id === selection.id)?.capacity ?? 60
    const duties = primary.bundle.compile?.duties.filter((d) => d.vehicle_id === selection.id) ?? []
    const line = primary.bundle.compile?.line_schedule[selection.id] ?? []
    const currentLine = [...line].reverse().find((l) => l[0] <= t)?.[1] ?? '—'
    const boarded = primary.bundle.events.filter((e) => e.vehicle_id === selection.id && e.event === 'board')
    const aboard = primary.bundle.events
      .filter((e) => e.vehicle_id === selection.id && e.t <= t && (e.event === 'board' || e.event === 'alight'))
      .reduce<Set<string>>((s, e) => {
        if (e.event === 'board') s.add(e.person_id)
        else s.delete(e.person_id)
        return s
      }, new Set())
    return (
      <div className="inspector">
        <h2>{selection.id}</h2>
        <div className="small">
          <div>
            onboard {seriesAt(occ, t) ?? 0}/{cap} · line <span className="mono">{currentLine}</span>
          </div>
          <div className="dim">
            boardings total {boarded.length} · peak {primary.bundle.run.metrics?.max_occupancy[selection.id] ?? 0}
          </div>
        </div>
        <Spark series={occ} max={cap} t={t} />
        <div className="small">
          <b>duty ledger</b>
          {duties.map((d) => (
            <div key={d.duty_id} className={`duty ${t >= d.depart_s && t <= d.est_end_s ? 'now' : ''}`}>
              <span className="mono">{d.duty_id}</span> dep {fmt(d.depart_s)} → {d.stop_sequence.map((s) => pack?.stops.find((x) => x.stop_id === s)?.name ?? s).join(' → ')}
              <span className="dim"> est end {fmt(d.est_end_s)}</span>
              <button className="tiny" onClick={() => setT(d.depart_s)}>
                go
              </button>
            </div>
          ))}
        </div>
        <div className="small">
          <b>aboard now ({aboard.size})</b>
          <div className="wrap">
            {[...aboard].slice(0, 60).map((p) => (
              <button key={p} className="tiny" onClick={() => select({ kind: 'person', id: p })}>
                {p}
              </button>
            ))}
          </div>
        </div>
        <button onClick={() => select(null)}>close</button>
      </div>
    )
  }

  if (selection.kind === 'car') {
    const ix = primary.tracks[selection.id]
    const pid = selection.id.startsWith('car_') ? selection.id.slice(4) : null
    return (
      <div className="inspector">
        <h2>{selection.id}</h2>
        <div className="small dim">
          {selection.id.startsWith('bg_') ? 'background traffic (synthetic, fixed count)' : 'cohort traveler driving their own car'} · samples {ix?.times.length ?? 0}
        </div>
        {pid && (
          <button className="tiny" onClick={() => select({ kind: 'person', id: pid })}>
            open traveler {pid}
          </button>
        )}
        <button onClick={() => select(null)}>close</button>
      </div>
    )
  }

  // person
  const evs = primary.personEvents[selection.id] ?? []
  const mode = primary.bundle.compile?.mode_assignment[selection.id]
  const state = personStateAt(evs, t, mode)
  const cohort = primary.bundle.run.metrics
  const unroutableReason = primary.bundle.compile?.unroutable[selection.id]
  return (
    <div className="inspector">
      <h2>{selection.id}</h2>
      <div className="small">
        <div>
          now: <b>{state}</b> · mode {mode ?? '?'}
        </div>
        {unroutableReason && <div className="bad">unroutable: {unroutableReason}</div>}
        <div className="dim">cohort of {cohort?.cohort_size} synthetic travelers</div>
      </div>
      <div className="small">
        <b>journey (recorded events)</b>
        {evs.length === 0 && <div className="dim">no events recorded for this traveler</div>}
        {evs.map((e, i) => (
          <div key={i} className={`ev ${e.t <= t ? 'past' : ''}`}>
            <span className="mono">{fmt(e.t)}</span> {e.event}
            {e.vehicle_id && (
              <>
                {' '}
                <button className="tiny" onClick={() => select({ kind: e.vehicle_id!.startsWith('bus') ? 'bus' : 'car', id: e.vehicle_id! })}>
                  {e.vehicle_id}
                </button>
              </>
            )}
            {e.stop_id && (
              <button className="tiny" onClick={() => select({ kind: 'stop', id: e.stop_id! })}>
                @{pack?.stops.find((s) => s.stop_id === e.stop_id)?.name ?? e.stop_id}
              </button>
            )}
            <button className="tiny" onClick={() => setT(e.t)}>
              go
            </button>
          </div>
        ))}
      </div>
      <button onClick={() => select(null)}>close</button>
    </div>
  )
}
