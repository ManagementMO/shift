import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useStore, type ToolId } from '../store'
import type { Corridor, ServicePlan } from '../types'
import { fmt } from '../util'
import { ghostFromProposal } from './ghost'
import ProposalCard from './ProposalCard'

const TITLES: Record<ToolId, string> = {
  closure: 'Close or reopen a street',
  route: 'Add a bus route',
  stop: 'Bus stops',
  population: 'Population',
  event: 'Event',
  weather: 'Moving hazard',
  road: 'Roads',
  intersection: 'Intersections',
}

export default function ToolPanel() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  if (!tool) return null
  return (
    <aside className="toolpanel">
      <div className="toolpanel-head">
        <b>{TITLES[tool]}</b>
        <button className="iconbtn small" onClick={() => setTool(null)} aria-label="Close">
          ✕
        </button>
      </div>
      {tool === 'closure' && <ClosureTool />}
      {tool === 'weather' && <HazardTool />}
      {tool === 'route' && <RouteTool />}
      {tool === 'stop' && <StopTool />}
      {tool === 'population' && <PopulationTool />}
      {tool === 'event' && <EventTool />}
      {(tool === 'road' || tool === 'intersection') && <StructuralTool kind={tool} />}
      <ProposalCard />
    </aside>
  )
}

function usePreview() {
  const scenarioId = useStore((s) => s.scenarioId)
  const pack = useStore((s) => s.pack)
  const setGhost = useStore((s) => s.setGhost)
  const setError = useStore((s) => s.setError)
  const [busy, setBusy] = useState(false)
  const preview = async (prompt: string) => {
    if (!scenarioId) return
    setBusy(true)
    try {
      setGhost(ghostFromProposal(await api.previewEdit(scenarioId, prompt), pack))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return { preview, busy }
}

function WindowPicker({ start, end, setStart, setEnd, horizon }: { start: number; end: number; setStart: (v: number) => void; setEnd: (v: number) => void; horizon: number }) {
  return (
    <div className="row small">
      <label>
        from +{fmt(start)}
        <input type="range" min={0} max={horizon} step={60} value={start} onChange={(e) => setStart(Math.min(Number(e.target.value), end))} />
      </label>
      <label>
        to +{fmt(end)}
        <input type="range" min={0} max={horizon} step={60} value={end} onChange={(e) => setEnd(Math.max(Number(e.target.value), start))} />
      </label>
    </div>
  )
}

function ClosureTool() {
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const setGhost = useStore((s) => s.setGhost)
  const [corridors, setCorridors] = useState<Record<string, Corridor>>({})
  const [key, setKey] = useState<string>('')
  const [mode, setMode] = useState<'close' | 'reopen'>('close')
  const horizon = scenario?.constraints.horizon_s ?? 2700
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(horizon)
  const { preview, busy } = usePreview()

  useEffect(() => {
    if (!pack) return
    void api.corridors(pack.pack_id).then((c) => {
      setCorridors(c)
      const first = Object.keys(c).find((k) => !c[k].flagship_closure) ?? Object.keys(c)[0] ?? ''
      setKey(first)
    })
  }, [pack])

  // Placement preview: hovering/selecting a corridor ghosts it on the world before any agent call.
  useEffect(() => {
    const c = corridors[key]
    if (!c) return
    setGhost({ proposal: null, edges: c.edge_ids, stops: [], hazard: null })
  }, [key, corridors, setGhost])

  const closedKeys = useMemo(() => {
    const closed = new Set(scenario?.restrictions.flatMap((r) => r.edge_ids) ?? [])
    return new Set(Object.keys(corridors).filter((k) => corridors[k].edge_ids.some((e) => closed.has(e))))
  }, [corridors, scenario])

  return (
    <div className="tool">
      <div className="seg">
        <button className={mode === 'close' ? 'on' : ''} onClick={() => setMode('close')}>
          Close
        </button>
        <button className={mode === 'reopen' ? 'on' : ''} onClick={() => setMode('reopen')}>
          Reopen
        </button>
      </div>
      <div className="list">
        {Object.entries(corridors).map(([k, c]) => (
          <button key={k} className={`listitem ${key === k ? 'on' : ''}`} onClick={() => setKey(k)}>
            <span>{c.label}</span>
            <span className="dim">
              {c.edge_ids.length} seg{closedKeys.has(k) ? ' · closed now' : ''}
            </span>
          </button>
        ))}
      </div>
      {mode === 'close' && <WindowPicker start={start} end={end} setStart={setStart} setEnd={setEnd} horizon={horizon} />}
      <button
        className="primary"
        disabled={!key || busy}
        onClick={() => void preview(mode === 'close' ? `close ${corridors[key].label} from ${fmt(start)} to ${fmt(end)}` : `reopen ${corridors[key].label}`)}
      >
        {busy ? 'Proposing…' : 'Preview'}
      </button>
    </div>
  )
}

function HazardTool() {
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const horizon = scenario?.constraints.horizon_s ?? 2700
  const places = useMemo(() => [{ id: 'venue', name: 'the venue' }, ...(pack?.zones.map((z) => ({ id: z.zone_id, name: z.name })) ?? [])], [pack])
  const [from, setFrom] = useState('venue')
  const [toChoice, setTo] = useState('')
  const to = toChoice || places[1]?.id || ''
  const [radius, setRadius] = useState(250)
  const [start, setStart] = useState(Math.round(horizon * 0.3))
  const [end, setEnd] = useState(Math.round(horizon * 0.7))
  const { preview, busy } = usePreview()
  const name = (id: string) => places.find((p) => p.id === id)?.name ?? id
  return (
    <div className="tool">
      <div className="small dim">A declared moving hazard region: roads inside its footprint become unavailable while it passes. It is not a weather model.</div>
      <label className="small">
        from
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        towards
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          {places.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        radius {radius} m
        <input type="range" min={100} max={600} step={25} value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
      </label>
      <WindowPicker start={start} end={end} setStart={setStart} setEnd={setEnd} horizon={horizon} />
      <button className="primary" disabled={busy || !to} onClick={() => void preview(`storm corridor via ${name(from)} and ${name(to)} ${radius} m from ${fmt(start)} to ${fmt(end)}`)}>
        {busy ? 'Proposing…' : 'Preview path'}
      </button>
    </div>
  )
}

function RouteTool() {
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const scenarioId = useStore((s) => s.scenarioId)
  const plans = useStore((s) => s.plans)
  const setError = useStore((s) => s.setError)
  const setGhost = useStore((s) => s.setGhost)
  const [vehicle, setVehicle] = useState(scenario?.constraints.fleet[0]?.vehicle_id ?? '')
  const [seq, setSeq] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const allowed = useMemo(() => new Set(scenario?.constraints.allowed_stop_ids ?? []), [scenario])
  const stops = useMemo(() => {
    const list = pack?.stops ?? []
    const lq = q.trim().toLowerCase()
    return list.filter((s) => (!lq || s.name.toLowerCase().includes(lq)) && (lq || allowed.has(s.stop_id))).slice(0, 12)
  }, [pack, q, allowed])

  useEffect(() => {
    setGhost({ proposal: null, edges: [], stops: pack?.stops.filter((s) => seq.includes(s.stop_id)) ?? [], hazard: null })
  }, [seq, pack, setGhost])

  const submit = async () => {
    if (!scenarioId || seq.length < 2) return
    setBusy(true)
    try {
      const plan: ServicePlan = {
        plan_id: `route-${vehicle}-${seq.map((s) => s.slice(-4)).join('-')}`.toLowerCase().replace(/[^a-z0-9-]/g, ''),
        name: `Route ${seq.map((s) => pack?.stops.find((x) => x.stop_id === s)?.name ?? s).join(' → ')}`,
        family: 'custom',
        duties: [{ duty_id: `${vehicle}-d1`, vehicle_id: vehicle, stop_sequence: seq, depart_s: scenario?.constraints.service_window_s[0] ?? 0, layover_s: 60 }],
        authored_by: 'user',
        rationale: 'Drawn in the route tool.',
        assumptions: [],
        parent_plan_id: null,
      }
      const pv = await api.submitPlan(scenarioId, plan)
      useStore.setState({ plans: [...plans.filter((p) => p.plan.plan_id !== pv.plan.plan_id), pv] })
      setResult(pv.validation?.valid ? 'Valid — run it from the scenario drawer.' : `Rejected: ${pv.validation?.issues.map((i) => i.message).join('; ')}`)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tool">
      <div className="small dim">A route is a plan: one shuttle serving a stop sequence, validated by the same rules as agent plans.</div>
      <label className="small">
        vehicle
        <select value={vehicle} onChange={(e) => setVehicle(e.target.value)}>
          {scenario?.constraints.fleet.map((f) => (
            <option key={f.vehicle_id} value={f.vehicle_id}>
              {f.vehicle_id} · {f.capacity} seats
            </option>
          ))}
        </select>
      </label>
      <input placeholder="find a stop (e.g. Union, Queens Quay)" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="list">
        {stops.map((s) => (
          <button key={s.stop_id} className={`listitem ${seq.includes(s.stop_id) ? 'on' : ''}`} onClick={() => setSeq(seq.includes(s.stop_id) ? seq.filter((x) => x !== s.stop_id) : [...seq, s.stop_id])}>
            <span>{s.name}</span>
            <span className="dim">{allowed.has(s.stop_id) ? 'allowed' : 'not in allowed set'}</span>
          </button>
        ))}
      </div>
      {seq.length > 0 && <div className="small">{seq.map((s, i) => `${i + 1}. ${pack?.stops.find((x) => x.stop_id === s)?.name ?? s}`).join('  ')}</div>}
      <button className="primary" disabled={busy || seq.length < 2 || !vehicle} onClick={() => void submit()}>
        {busy ? 'Validating…' : 'Validate route'}
      </button>
      {result && <div className="small">{result}</div>}
    </div>
  )
}

function StopTool() {
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const { preview, busy } = usePreview()
  const allowed = pack?.stops.filter((s) => scenario?.constraints.allowed_stop_ids.includes(s.stop_id)) ?? []
  const name = (id: string) => pack?.stops.find((s) => s.stop_id === id)?.name ?? id
  return (
    <div className="tool">
      <div className="small dim">Stops are real OSM bus stops plus declared shuttle bays (marked “declared”). Move boarding from one to another; plans are re-validated.</div>
      <label className="small">
        withdraw
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">—</option>
          {allowed.map((s) => (
            <option key={s.stop_id} value={s.stop_id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        use instead
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">—</option>
          {pack?.stops.slice(0, 200).map((s) => (
            <option key={s.stop_id} value={s.stop_id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <button className="primary" disabled={!from || !to || busy} onClick={() => void preview(`move stop ${name(from)} to ${name(to)}`)}>
        {busy ? 'Proposing…' : 'Preview'}
      </button>
      <div className="small dim">Adding a brand-new stop needs a network rebuild (netconvert); it is not available live in this build.</div>
    </div>
  )
}

function PopulationTool() {
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const createFlagship = useStore((s) => s.createFlagship)
  const building = useStore((s) => s.building)
  const [n, setN] = useState(240)
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    useStore.setState({ building: `Generating ${n} synthetic travelers · compiling scenario…` })
    try {
      await createFlagship(n, 7)
    } finally {
      useStore.setState({ building: null })
      setBusy(false)
    }
  }
  return (
    <div className="tool">
      <div className="small dim">Demand is synthetic and declared as such. Changing the cohort compiles a new scenario (it is not a live edit).</div>
      <label className="small">
        travelers leaving the venue: <b>{n}</b>
        <input type="range" min={20} max={2000} step={20} value={n} onChange={(e) => setN(Number(e.target.value))} />
      </label>
      <button className="primary" disabled={busy || !!building} onClick={() => void go()}>
        {busy ? 'Compiling…' : `Build scenario with ${n} travelers`}
      </button>
      {scenario && <div className="small dim">current: {scenario.scenario_id}</div>}
    </div>
  )
}

function EventTool() {
  const pack = useStore((s) => s.pack)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  return (
    <div className="tool">
      <div className="small">Event egress at {pack ? 'the venue' : '—'}: everyone leaves at once when the event ends (+00:00).</div>
      {scenario && (
        <div className="small dim">
          fleet {scenario.constraints.fleet.map((f) => `${f.vehicle_id} (${f.capacity})`).join(', ')} · service window +{fmt(scenario.constraints.service_window_s[0])}–+{fmt(scenario.constraints.service_window_s[1])} · horizon +{fmt(scenario.constraints.horizon_s)}
        </div>
      )}
      <div className="small dim">Change crowd size with Population or assign shuttle service with Bus route.</div>
    </div>
  )
}

function StructuralTool({ kind }: { kind: 'road' | 'intersection' }) {
  return (
    <div className="tool">
      <div className="small">
        <b>Not available live.</b> Adding a {kind} changes the SUMO network itself and needs a netconvert rebuild of the city pack, then a fresh compile of every scenario on it.
      </div>
      <div className="small dim">What you can do now without pretending: close or reopen existing streets (Closure), or move boarding between existing stops (Bus stop). Both branch the scenario and re-run in SUMO.</div>
    </div>
  )
}
