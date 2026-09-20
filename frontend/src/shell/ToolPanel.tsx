import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useStore, type ToolId } from '../store'
import { AREAS, startPick } from '../world/areaSelect'
import { leadMap } from '../world/registry'
import { ghostFromProposal } from './ghost'
import ProposalCard from './ProposalCard'
import DevelopmentTool from './DevelopmentTool'

const TITLES: Record<ToolId, string> = {
  area: 'Area select',
  closure: 'Road closures',
  development: 'New development',
  population: 'Population',
}

export default function ToolPanel() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  if (!tool) return null
  return (
    <aside className={`toolpanel ${tool === 'development' ? 'toolpanel-development' : ''}`}>
      <div className="toolpanel-head">
        <b>{TITLES[tool]}</b>
        <button className="iconbtn small" onClick={() => setTool(null)} aria-label="Close">
          ✕
        </button>
      </div>
      {tool === 'area' && <AreaTool />}
      {tool === 'closure' && <ClosureTool />}
      {tool === 'development' && <DevelopmentTool />}
      {tool === 'population' && <PopulationTool />}
      <ProposalCard />
    </aside>
  )
}

/**
 * District / Corridor pickers.  Choosing one closes this panel, frames every candidate and opens the pick: the
 * cursor turns to a crosshair, the city outlines the regions and tints the one under the pointer, and a click
 * flies in and closes the pick.  Escape, choosing the active picker again, or another tool ends it where the
 * camera is.
 */
function AreaTool() {
  const picking = useStore((s) => s.picking)
  const cameraMode = useStore((s) => s.cameraMode)
  const setPicking = useStore((s) => s.setPicking)
  const pack = useStore((s) => s.pack)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const update = () => {
      const lead = leadMap()
      setReady(Boolean(lead && (!lead.cameraLocked || lead.setCameraPreset)))
    }
    update()
    const id = setInterval(update, 500)
    return () => clearInterval(id)
  }, [pack])
  const open = picking ? AREAS.find((a) => a.id === cameraMode) ?? null : null
  return (
    <div className="tool">
      <div className="small dim">Zoom to a part of the city by pointing at it.</div>
      <div className="list">
        {AREAS.map((a) => {
          const on = open?.id === a.id
          return (
            <button key={a.id} className={`listitem ${on ? 'on' : ''}`} aria-pressed={on} disabled={!ready || !pack} onClick={() => (on ? setPicking(false) : startPick(a.id))} title={`${a.label} (${a.key})`}>
              <span>
                {a.label} <span className="dim">· {a.key}</span>
              </span>
              <span className="dim">{a.hint}</span>
            </button>
          )
        })}
      </div>
      <div className="small dim">{open ? `Choosing a ${open.label.toLowerCase()} — point at one on the map and click to zoom, Esc to stop.` : 'Districts are the pack’s destination zones and the venue; corridors are its named streets.'}</div>
    </div>
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

/** Close a corridor for the whole scenario. Closed corridors are removed from the city itself: click the closure, then Remove. */
function ClosureTool() {
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const setGhost = useStore((s) => s.setGhost)
  const select = useStore((s) => s.select)
  const corridors = useStore((s) => s.corridors)
  const [picked, setKey] = useState<string | null>(null)
  const key = picked && corridors[picked] ? picked : ''
  const { preview, busy } = usePreview()

  // Corridor -> the restriction already closing (part of) it, so the list can hand off to the closure card.
  const closedBy = useMemo(() => {
    const out = new Map<string, string>()
    for (const [k, c] of Object.entries(corridors)) {
      const r = scenario?.restrictions.find((x) => x.edge_ids.some((e) => c.edge_ids.includes(e)))
      if (r) out.set(k, r.restriction_id)
    }
    return out
  }, [corridors, scenario])

  // Placement preview: selecting an open corridor ghosts it on the world before any agent call.
  useEffect(() => {
    const c = corridors[key]
    if (!c || closedBy.has(key)) return
    setGhost({ proposal: null, edges: c.edge_ids, stops: [], hazard: null })
  }, [key, corridors, closedBy, setGhost])

  const pick = (k: string) => {
    const rid = closedBy.get(k)
    if (rid) {
      select({ kind: 'restriction', id: rid })
      return
    }
    setKey(k)
  }

  return (
    <div className="tool">
      <div className="small dim">A closed street stays closed for the whole scenario. To reopen one, click the red closure on the city and choose Remove closure.</div>
      <div className="list">
        {Object.entries(corridors).map(([k, c]) => (
          <button key={k} className={`listitem ${key === k ? 'on' : ''}`} onClick={() => pick(k)} aria-pressed={key === k}>
            <span>{c.label}</span>
            <span className={closedBy.has(k) ? 'closed' : 'dim'}>
              {c.edge_ids.length} seg{closedBy.has(k) ? ' · closed — click to manage' : ''}
            </span>
          </button>
        ))}
      </div>
      <button className="primary" disabled={!key || closedBy.has(key) || busy} onClick={() => void preview(`close ${corridors[key].label}`)}>
        {busy ? 'Proposing…' : key ? 'Preview closure' : 'Choose a street'}
      </button>
    </div>
  )
}

export const POPULATION_MIN_SIMULATED = 10
export const POPULATION_MAX = 2000

function PopulationTool() {
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const current = useStore((s) => Object.keys(s.travelers).length)
  const createFlagship = useStore((s) => s.createFlagship)
  const building = useStore((s) => s.building)
  // The bar reflects the loaded scenario until the user drags it; `pending` is cleared once a rebuild lands.
  const [pending, setPending] = useState<{ scenarioId: string | null; value: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const n = pending && pending.scenarioId === (scenario?.scenario_id ?? null) ? pending.value : current
  const setN = (value: number) => setPending({ scenarioId: scenario?.scenario_id ?? null, value })
  const pct = (Math.min(n, POPULATION_MAX) / POPULATION_MAX) * 100
  const dirty = n !== current
  const tooFew = n < POPULATION_MIN_SIMULATED
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
    <div className="tool population-tool">
      <div className="population-head small">
        <span>Population in the area</span>
        <span className="dim">{scenario ? `${current.toLocaleString()} simulated now` : 'no scenario yet'}</span>
      </div>
      <div className="population-bar" style={{ '--pct': `${pct}%` } as React.CSSProperties}>
        <output htmlFor="population-range" style={{ left: `calc(${pct}% + ${(0.5 - pct / 100) * 18}px)` }}>{n.toLocaleString()}</output>
        <input id="population-range" type="range" aria-label="Population in the area" min={0} max={POPULATION_MAX} step={1} value={n} onChange={(e) => setN(Number(e.target.value))} disabled={busy || !!building} />
        <div className="population-ticks"><span>0</span><span>{POPULATION_MAX.toLocaleString()} max</span></div>
      </div>
      <button className="primary" disabled={busy || !!building || tooFew || !dirty} onClick={() => void go()}>
        {busy ? 'Compiling…' : tooFew ? `At least ${POPULATION_MIN_SIMULATED} people to simulate` : dirty ? `Set population to ${n.toLocaleString()}` : 'Population unchanged'}
      </button>
      <div className="small dim">
        Synthetic crowd leaving the venue; {POPULATION_MAX.toLocaleString()} is this simulator’s live ceiling, not the area’s census population. Applying compiles a new base scenario{scenario?.parent_scenario_id ? ' — developments on this branch are not carried over' : ''}.
      </div>
    </div>
  )
}
