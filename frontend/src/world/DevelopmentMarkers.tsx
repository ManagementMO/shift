import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { DEVELOPMENT_USES, developmentActivity, developmentCounts, scenarioForView, validDevelopmentGeometry } from '../development'
import { useStore } from '../store'
import { mapForSide } from './registry'

export default function DevelopmentMarkers({ runId, side }: { runId: string | null; side: string }) {
  const scenarios = useStore((s) => s.scenarios)
  const selectedId = useStore((s) => s.scenarioId)
  const bundle = useStore((s) => runId ? s.replays[runId]?.bundle ?? null : null)
  const draft = useStore((s) => s.developmentDraft)
  const placed = useStore((s) => s.developmentPlaced)
  const preview = useStore((s) => s.developmentPreview)
  const error = useStore((s) => s.developmentError)
  const selection = useStore((s) => s.selection)
  const t = useStore((s) => s.t)
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const rows = useMemo(() => {
    const scenario = scenarioForView(scenarios, selectedId, bundle, side)
    const saved = (scenario?.developments ?? []).map((d) => ({ id: d.development_id, spec: d.spec, draft: false }))
    if (side !== 'left' && draft && placed && validDevelopmentGeometry(draft)) saved.push({ id: 'draft', spec: draft, draft: true })
    return saved
  }, [scenarios, selectedId, bundle, side, draft, placed])

  useEffect(() => {
    let raf = 0
    const update = () => {
      const map = mapForSide(side)
      for (const row of rows) {
        const node = refs.current.get(row.id)
        if (!node) continue
        const p = map?.projectElevated?.(row.spec.position, row.spec.height_m + 5) ?? map?.project(row.spec.position)
        node.style.visibility = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? 'visible' : 'hidden'
        if (p) node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`
      }
      raf = requestAnimationFrame(update)
    }
    update()
    return () => cancelAnimationFrame(raf)
  }, [rows, side])

  const selected = rows.some((row) => row.draft || (selection?.kind === 'development' && selection.id === row.id))
  return <div className="development-markers" aria-label="Development map events">
    {side !== 'left' && draft && !placed && <div className="development-map-hint glass"><b>Place a development</b><span>Click land beside a street. Drag to pan; scroll to zoom.</span></div>}
    {rows.map((row) => {
      const use = DEVELOPMENT_USES[row.spec.land_use]
      const active = developmentActivity(row.spec, t)
      const counts = developmentCounts(row.spec)
      return <button key={row.id} ref={(node) => { if (node) refs.current.set(row.id, node); else refs.current.delete(row.id) }}
        className={`development-pin ${row.draft ? 'draft' : ''} ${active ? 'active' : ''} ${selection?.id === row.id ? 'selected' : ''}`}
        style={{ '--development-color': row.draft ? error ? '#c75d44' : '#1598b0' : use.color } as CSSProperties}
        aria-label={`${row.draft ? 'Preview' : 'Inspect'} ${row.spec.name}`}
        onClick={(event) => {
          event.stopPropagation()
          if (row.draft) return
          const store = useStore.getState()
          store.setTool('development')
          store.select({ kind: 'development', id: row.id })
        }}>
        <span className="development-pin-glyph" aria-hidden="true">▥</span>
        <span className="development-pin-copy"><small>{row.draft ? preview ? 'READY TO CONFIRM' : 'DRAFT · NOT APPLIED' : 'NEW DEVELOPMENT'}</small><b>{row.spec.name}</b><span>{row.spec.capacity.toLocaleString()} {use.unit} · {counts.trips.toLocaleString()} trips</span></span>
        {!row.draft && active && <i title={`${active} departure wave active`} />}
      </button>
    })}
    {selected && <div className="development-map-key">Colored footprint = scenario development · arrows = declared travel directions, not routes</div>}
  </div>
}
