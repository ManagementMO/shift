// Area select: the District / Corridor pickers.  Starting one frames every candidate region so it can be
// pointed at and opens the pick; the city then tints the region under the pointer and a click flies in.
import { useStore } from '../store'
import { edgePath } from '../util'
import { cityPose, currentPose, districtPose, framePose } from './camera'
import { cameraTo, leadMap } from './registry'

export type AreaKind = 'district' | 'corridor'

export const AREAS: { id: AreaKind; label: string; key: string; hint: string }[] = [
  { id: 'district', label: 'District', key: '2', hint: 'Point at a district on the map and click to zoom in.' },
  { id: 'corridor', label: 'Corridor', key: '3', hint: 'Point at a street corridor and click to frame it.' },
]

/** Open the picker for `kind`: frame its candidates and let the world take the click. */
export function startPick(kind: AreaKind): void {
  const lead = leadMap()
  if (!lead) return
  const s = useStore.getState()
  const pack = s.pack
  const base = pack ? cityPose(pack.pack_id, pack.center) : currentPose(lead)
  const venue: [number, number] | null = pack ? [pack.venue_lonlat[0], pack.venue_lonlat[1]] : null
  s.setPicking(true)
  if (kind === 'district') {
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
