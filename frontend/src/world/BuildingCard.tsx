import { useEffect, useRef, useState } from 'react'
import { DEVELOPMENT_USES, developmentCounts, developmentLabel } from '../development'
import { useStore } from '../store'
import { mapForSide } from './registry'

const CATEGORY_LABEL: Record<string, string> = {
  generic: 'Building', residential: 'House', apartments: 'Apartment building', retail: 'Retail', utility: 'Utility building',
  civic: 'Civic building', office: 'Office building', tower: 'Tower', commercial: 'Commercial building', hotel: 'Hotel',
  industrial: 'Industrial building', landmark: 'Landmark',
}

/**
 * Two-step delete: the first click arms it, the second confirms. Shared by the map card and the development panel so
 * a confirmed building never disappears on a single stray click.
 */
export function DeleteButton({ label, prompt, onConfirm, busy }: { label: string; prompt: string; onConfirm: () => void; busy: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 6000)
    return () => clearTimeout(id)
  }, [armed])
  if (busy) return <button className="ghostbtn danger" disabled>Deleting…</button>
  if (!armed) return <button className="ghostbtn danger" onClick={() => setArmed(true)}>{label}</button>
  return <span className="delete-confirm">
    <span className="small">{prompt}</span>
    <button className="primary danger" onClick={onConfirm}>Yes, delete</button>
    <button className="ghostbtn" onClick={() => setArmed(false)}>Keep</button>
  </span>
}

/**
 * The card that opens when a building is clicked: a saved development or any base-city building/landmark. It sits
 * above the building and offers Delete, which edits the current scenario in place.
 */
export default function BuildingCard({ side }: { side: string }) {
  const selection = useStore((s) => s.selection)
  const tool = useStore((s) => s.tool)
  const scenario = useStore((s) => s.scenarios.find((x) => x.scenario_id === s.scenarioId) ?? null)
  const deleting = useStore((s) => s.deleting)
  const select = useStore((s) => s.select)
  const setTool = useStore((s) => s.setTool)
  const removeDevelopment = useStore((s) => s.removeDevelopment)
  const demolishBuilding = useStore((s) => s.demolishBuilding)
  const ref = useRef<HTMLDivElement>(null)

  const development = selection?.kind === 'development' ? scenario?.developments?.find((d) => d.development_id === selection.id) ?? null : null
  // The development panel already shows this building's details (e.g. right after confirming); don't double up.
  const show = selection?.kind === 'building' || (development && tool !== 'development')
  const anchor: { position: [number, number]; height: number } | null = !show ? null
    : selection?.kind === 'building' ? { position: selection.position, height: selection.height_m }
    : development ? { position: development.spec.position, height: development.spec.height_m } : null

  const [lon, lat, height] = anchor ? [anchor.position[0], anchor.position[1], anchor.height] : [null, null, null]
  useEffect(() => {
    if (lon === null || lat === null || height === null) return
    let raf = 0
    const update = () => {
      const node = ref.current
      const map = mapForSide(side)
      const p = map?.projectElevated?.([lon, lat], height + 4) ?? map?.project([lon, lat])
      if (node) {
        node.style.visibility = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? 'visible' : 'hidden'
        if (p) {
          node.style.left = `${Math.round(p.x)}px`
          node.style.top = `${Math.round(p.y)}px`
        }
      }
      raf = requestAnimationFrame(update)
    }
    update()
    return () => cancelAnimationFrame(raf)
  }, [lon, lat, height, side])

  if (!anchor || !selection) return null
  const busy = deleting === selection.id
  if (selection.kind === 'building') {
    const category = CATEGORY_LABEL[selection.category] ?? 'Building'
    return <div ref={ref} className="bubble building-card" role="dialog" aria-label={`${selection.label}, ${category}`}>
      <div className="bubble-head"><b>{selection.label}</b><span className="pill">{selection.category === 'landmark' ? 'landmark' : 'city'}</span></div>
      <div className="small dim">{category}{selection.height_m ? ` · ${Math.round(selection.height_m)} m` : ''} · {selection.id}</div>
      <div className="row">
        <DeleteButton label="Delete" busy={busy} prompt="Remove this building from the scenario? It generates no trips, so only the map changes."
          onConfirm={() => void demolishBuilding(selection.id)} />
        <button className="ghostbtn" onClick={() => select(null)}>Close</button>
      </div>
    </div>
  }
  if (!development) return null
  const { spec } = development
  const counts = developmentCounts(spec)
  return <div ref={ref} className="bubble building-card" role="dialog" aria-label={`${spec.name}, development`}>
    <div className="bubble-head"><b>{spec.name}</b><span className="pill">{developmentLabel(spec).toLowerCase()}</span></div>
    <div className="small dim">{spec.capacity.toLocaleString()} {DEVELOPMENT_USES[spec.land_use].unit} · {counts.trips.toLocaleString()} one-way trips · saved in this scenario</div>
    <div className="row">
      <DeleteButton label="Delete" busy={busy} prompt={`Remove ${spec.name} and its ${counts.trips.toLocaleString()} trips from this scenario?`}
        onConfirm={() => void removeDevelopment(development.development_id)} />
      <button className="ghostbtn" onClick={() => { setTool('development'); select({ kind: 'development', id: development.development_id }) }}>Details</button>
      <button className="ghostbtn" onClick={() => select(null)}>Close</button>
    </div>
  </div>
}
