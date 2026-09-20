import { abstractEntityId, bindingAt, populationTrackVisible, residentForEntityAt } from './population'
import { lonLatAt, type ReplayIndex } from './replay'
import type { Selection } from './store'
import type { EntityTrack } from './types'

export function selectedResidentId(rx: ReplayIndex, selection: Selection, t: number): string | null {
  if (!rx.population || !selection || selection.kind === 'stop' || selection.kind === 'restriction') return null
  if (selection.kind === 'resident') return rx.population.profiles[selection.id] ? selection.id : null
  return residentForEntityAt(rx.population, selection.id, t)
}

export function selectionForEntity(rx: ReplayIndex, id: string, kind: EntityTrack['kind'], t: number): Selection {
  const residentId = rx.population ? residentForEntityAt(rx.population, id, t) : null
  return residentId ? { kind: 'resident', id: residentId } : { kind, id }
}

export function selectionEntityId(rx: ReplayIndex, selection: Selection, t: number): string | null {
  if (!selection || selection.kind === 'stop' || selection.kind === 'restriction') return null
  if (selection.kind === 'resident') {
    const b = rx.population ? bindingAt(rx.population, selection.id, t) : null
    if (!b) return null
    return b.ownership === 'abstract' ? abstractEntityId(selection.id) : b.entity_id
  }
  if (rx.bundle.run.run_kind !== 'population' && selection.kind === 'person') {
    const car = rx.tracks[`car_${selection.id}`]
    if (car && lonLatAt(car, t)) return car.track.entity_id
    let aboard: string | null = null
    for (const e of rx.personEvents[selection.id] ?? []) {
      if (e.t > t) break
      if (e.event === 'board') aboard = e.vehicle_id
      if (e.event === 'alight' || e.event === 'arrive') aboard = null
    }
    if (aboard) return aboard
  }
  return selection.id
}

export function selectionPosition(rx: ReplayIndex, selection: Selection, t: number): [number, number] | null {
  const id = selectionEntityId(rx, selection, t)
  if (!id) return null
  if (selection?.kind === 'resident' && rx.population) {
    const b = bindingAt(rx.population, selection.id, t)
    if (b?.ownership === 'abstract' && !b.measured && b.anchor_id) {
      const anchor = rx.population.anchors[b.anchor_id]
      return anchor ? [anchor.lon, anchor.lat] : null
    }
  }
  const ix = rx.tracks[id]
  if (!ix || (rx.population && !populationTrackVisible(rx.population, ix.track, t))) return null
  return lonLatAt(ix, t)
}
