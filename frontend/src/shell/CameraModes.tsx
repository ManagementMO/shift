import { useEffect } from 'react'
import { useStore } from '../store'
import { cameraTo, leadMap, watchCameraMode } from '../world/registry'
import { cityPose, corridorPose, currentPose, districtPose, incidentPose, type CameraMode } from '../world/camera'
import { lonLatAt, hazardFootprint } from '../replay'

const MODES: { id: CameraMode; label: string; key: string }[] = [
  { id: 'city', label: 'City', key: '1' },
  { id: 'district', label: 'District', key: '2' },
  { id: 'corridor', label: 'Corridor', key: '3' },
  { id: 'agent', label: 'Agent', key: '4' },
  { id: 'incident', label: 'Incident', key: '5' },
]

export default function CameraModes() {
  const cameraMode = useStore((s) => s.cameraMode)
  const setCameraMode = useStore((s) => s.setCameraMode)

  useEffect(() => watchCameraMode(setCameraMode), [setCameraMode])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const m = MODES.find((x) => x.key === e.key)
      if (m) go(m.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <nav className="cams" aria-label="Camera">
      {MODES.map((m) => (
        <button key={m.id} className={cameraMode === m.id ? 'on' : ''} onClick={() => go(m.id)} title={`${m.label} (${m.key})`}>
          {m.label}
        </button>
      ))}
    </nav>
  )
}

/** Resolve a camera mode against what is actually in the scenario/replay right now. */
function go(mode: CameraMode) {
  const lead = leadMap()
  if (!lead) return
  const s = useStore.getState()
  const pack = s.pack
  const base = currentPose(lead)
  const scenario = s.scenarios.find((x) => x.scenario_id === s.scenarioId)
  const rx = s.primaryRunId ? s.replays[s.primaryRunId] : null
  const venue: [number, number] | null = pack ? [pack.venue_lonlat[0], pack.venue_lonlat[1]] : null

  switch (mode) {
    case 'city':
      if (pack) cameraTo(cityPose(pack.pack_id, pack.center), 'city')
      return
    case 'district':
      if (venue) cameraTo(districtPose(venue, base), 'district')
      return
    case 'corridor': {
      const r = scenario?.restrictions.find((x) => !x.restriction_id.startsWith('hazard')) ?? scenario?.restrictions[0]
      const pts = r ? edgePath(s.roads, r.edge_ids) : []
      if (pts.length >= 2) cameraTo(corridorPose(pts, base), 'corridor')
      else if (venue) cameraTo(districtPose(venue, base), 'corridor')
      return
    }
    case 'agent': {
      const sel = s.selection
      let pos: [number, number] | null = null
      if (rx && sel && sel.kind !== 'restriction' && sel.kind !== 'stop' && rx.tracks[sel.id]) pos = lonLatAt(rx.tracks[sel.id], s.t)
      if (!pos && rx) {
        // Nothing selected: follow the first shuttle that is on the road right now, else any moving entity.
        const bus = Object.values(rx.tracks).find((ix) => ix.track.kind === 'bus' && lonLatAt(ix, s.t))
        const any = bus ?? Object.values(rx.tracks).find((ix) => lonLatAt(ix, s.t))
        if (any) {
          pos = lonLatAt(any, s.t)
          s.select({ kind: any.track.kind, id: any.track.entity_id })
        }
      }
      if (pos) cameraTo({ center: [pos[0], pos[1]], zoom: 17.6, pitch: 66, bearing: base.bearing }, 'agent')
      return
    }
    case 'incident': {
      const h = scenario?.hazards[0]
      const fp = h ? hazardFootprint(h, Math.max(h.start_s, Math.min(s.t, h.end_s))) : null
      if (fp && h) cameraTo(incidentPose(fp.center, h.radius_m * 3, base), 'incident')
      else if (venue) cameraTo(incidentPose(venue, 400, base), 'incident')
      return
    }
  }
}

function edgePath(roads: GeoJSON.FeatureCollection | null, edgeIds: string[]): [number, number][] {
  if (!roads) return []
  const want = new Set(edgeIds)
  const pts: [number, number][] = []
  for (const f of roads.features) {
    if (!want.has(String(f.properties?.id)) || f.geometry.type !== 'LineString') continue
    for (const c of f.geometry.coordinates) pts.push([c[0], c[1]])
  }
  return pts
}
