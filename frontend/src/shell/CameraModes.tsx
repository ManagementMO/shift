import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { cameraTo, leadMap, watchCameraMode } from '../world/registry'
import { cityPose, currentPose, districtPose, framePose } from '../world/camera'
import { edgePath } from '../util'

type PickMode = 'district' | 'corridor'

const MODES: { id: PickMode; label: string; key: string; hint: string }[] = [
  { id: 'district', label: 'District', key: '2', hint: 'point at a district on the map and click to zoom in' },
  { id: 'corridor', label: 'Corridor', key: '3', hint: 'point at a street corridor and click to frame it' },
]

/**
 * District / Corridor pickers.  Pressing one frames every candidate and opens the pick: the city outlines the
 * regions and tints the one under the pointer; clicking flies in and closes the pick, Escape closes it where
 * the camera is.  Everything else in the city (buildings, agents, stops, closures) is clicked directly.
 */
export default function CameraModes({ active = true }: { active?: boolean }) {
  const cameraMode = useStore((s) => s.cameraMode)
  const picking = useStore((s) => s.picking)
  const setCameraMode = useStore((s) => s.setCameraMode)
  const pack = useStore((s) => s.pack)
  const [ready, setReady] = useState(false)

  useEffect(() => watchCameraMode(setCameraMode), [setCameraMode])

  // The pickers are offered once a map leads and can take a framing.
  useEffect(() => {
    const update = () => {
      const lead = leadMap()
      setReady(Boolean(lead && (!lead.cameraLocked || lead.setCameraPreset)))
    }
    update()
    const id = setInterval(update, 500)
    return () => clearInterval(id)
  }, [pack])

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || target?.isContentEditable || target?.closest('input, textarea, select')) return
      if (e.key === 'Escape') {
        // also while the just-clicked District / Corridor button still holds focus
        useStore.getState().setPicking(false)
        return
      }
      if (target?.closest('button')) return
      const m = MODES.find((x) => x.key === e.key)
      if (m) pick(m.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <nav className="cams" aria-label="Camera">
      {MODES.map((m) => {
        const on = picking && cameraMode === m.id
        return (
          <button key={m.id} className={on ? 'on' : ''} aria-pressed={on} disabled={!ready || !pack} onClick={() => (on ? useStore.getState().setPicking(false) : pick(m.id))} title={`${m.label} (${m.key}) — ${m.hint}`}>
            {m.label}
          </button>
        )
      })}
    </nav>
  )
}

/** Open a picker: frame every candidate region so it can be pointed at, then let the world take the click. */
function pick(mode: PickMode) {
  const lead = leadMap()
  if (!lead) return
  const s = useStore.getState()
  const pack = s.pack
  const base = pack ? cityPose(pack.pack_id, pack.center) : currentPose(lead)
  const venue: [number, number] | null = pack ? [pack.venue_lonlat[0], pack.venue_lonlat[1]] : null
  s.setPicking(true)
  if (mode === 'district') {
    const sites: [number, number][] = pack?.zones.map((z) => [z.lon, z.lat] as [number, number]) ?? []
    if (venue) sites.push(venue)
    if (sites.length > 1) cameraTo(framePose(sites, base), 'district')
    else if (venue) cameraTo(districtPose(venue, base), 'district')
    return
  }
  const all = edgePath(s.roads, Object.values(s.corridors).flatMap((c) => c.edge_ids))
  if (all.length >= 2) cameraTo(framePose(all, base), 'corridor')
  else if (venue) cameraTo(districtPose(venue, base), 'corridor')
}
