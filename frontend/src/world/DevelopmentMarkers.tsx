import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { DEVELOPMENT_USES, developmentColor, developmentCounts, validDevelopmentGeometry } from '../development'
import { useStore } from '../store'
import { mapForSide } from './registry'

/**
 * Placement-time label only: the pin over a placed-but-unconfirmed footprint. Confirmed developments are ordinary
 * city buildings and carry no marker; clicking one opens the building card instead.
 */
export default function DevelopmentMarkers({ side }: { runId: string | null; side: string }) {
  const draft = useStore((s) => s.developmentDraft)
  const placed = useStore((s) => s.developmentPlaced)
  const preview = useStore((s) => s.developmentPreview)
  const error = useStore((s) => s.developmentError)
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const rows = useMemo(() => side !== 'left' && draft && placed && validDevelopmentGeometry(draft) ? [{ id: 'draft', spec: draft, draft: true }] : [], [side, draft, placed])

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

  return <div className="development-markers" aria-label="Development placement">
    {rows.map((row) => {
      const use = DEVELOPMENT_USES[row.spec.land_use]
      const counts = developmentCounts(row.spec)
      return <button key={row.id} ref={(node) => { if (node) refs.current.set(row.id, node); else refs.current.delete(row.id) }}
        className="development-pin draft"
        style={{ '--development-color': error ? '#c75d44' : developmentColor(row.spec) } as CSSProperties}
        aria-label={`Preview ${row.spec.name}`}
        onClick={(event) => event.stopPropagation()}>
        <span className="development-pin-glyph" aria-hidden="true">▥</span>
        <span className="development-pin-copy"><small>{preview ? 'READY TO CONFIRM' : error ? 'CANNOT BUILD HERE' : 'CHECKING ACCESS…'}</small><b>{row.spec.name}</b><span>{row.spec.capacity.toLocaleString()} {use.unit} · {counts.trips.toLocaleString()} trips</span></span>
      </button>
    })}
  </div>
}
