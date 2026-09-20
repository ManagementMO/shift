import type { Ghost } from '../store'
import type { CityPack, InterventionProposal } from '../types'

/** Translate a typed backend proposal into what the world should draw as a ghost. */
export function ghostFromProposal(p: InterventionProposal, pack: CityPack | null): Ghost {
  const stops = p.target_stop_id ? pack?.stops.filter((s) => s.stop_id === p.target_stop_id) ?? [] : []
  return {
    proposal: p,
    edges: p.kind === 'reopen_edge' ? [] : p.edge_ids,
    stops,
    hazard: p.hazard,
  }
}

export function proposalTitle(p: InterventionProposal): string {
  switch (p.kind) {
    case 'close_edge':
      return `Close ${p.edge_ids.length} road segments`
    case 'reopen_edge':
      return `Remove closure · ${p.edge_ids.length} road segments`
    case 'set_fleet':
      return `Fleet → ${p.fleet_count} buses`
    case 'move_stop':
      return `Move boarding to ${p.target_stop_id}`
    case 'storm':
      return `Moving hazard · ${p.hazard?.radius_m ?? 0} m radius`
    default:
      return 'Not understood'
  }
}
