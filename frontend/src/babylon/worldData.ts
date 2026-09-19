/**
 * Types for `world.json` — the Babylon-ready Toronto compiled by backend/cityshift/citypack/world.py from the
 * SUMO network (roads/junctions/stops) and the pack's OSM tiles (buildings/green/rail/water).  Everything is in
 * world metres (x east, z north) already; see coords.ts for how lon/lat gets there.
 */

import type { WorldCrs } from './coords'

/** Flat [x0, z0, x1, z1, ...] */
export type Flat = number[]

export type Mode = 'bus' | 'car' | 'ped'

export interface WorldLane {
  shape: Flat
  w: number
  allow: Mode[]
}

export interface WorldRoad {
  /** canonical SUMO edge id */
  id: string
  shape: Flat
  w: number
  type: string
  kind: 'road' | 'path'
  allow: Mode[]
  prio: number
  speed: number
  from: string
  to: string
  lanes?: WorldLane[]
  name?: string
}

export interface WorldJunction {
  id: string
  ring: Flat
  type: string
  kind: 'road' | 'path'
  x: number
  z: number
}

export type BuildingCategory =
  | 'generic'
  | 'residential'
  | 'apartments'
  | 'retail'
  | 'utility'
  | 'civic'
  | 'office'
  | 'tower'
  | 'commercial'
  | 'hotel'
  | 'industrial'
  | 'landmark'

export interface WorldBuilding {
  id: string
  ring: Flat
  holes?: Flat[]
  h: number
  cat: BuildingCategory
  lm?: string
  name?: string
}

export type LandmarkKind =
  | 'cn_tower'
  | 'rogers_centre'
  | 'scotiabank_arena'
  | 'union_station'
  | 'city_hall'
  | 'roy_thomson_hall'
  | 'ripleys_aquarium'

export interface WorldLandmark {
  id: string
  kind: LandmarkKind
  name: string
  x: number
  z: number
  h: number
  ring: Flat
}

export interface WorldStop {
  id: string
  name: string
  edge: string
  x: number
  z: number
}

export interface WorldZone {
  id: string
  name: string
  x: number
  z: number
  share: number
}

export interface WorldAnchor {
  name: string
  lon: number
  lat: number
  x: number
  z: number
  junction?: string
}

export interface WorldData {
  version: number
  pack_id: string
  network_fingerprint: string
  crs: WorldCrs & { proj: string }
  anchors: WorldAnchor[]
  venue: { x: number; z: number; edge: string }
  stops: WorldStop[]
  zones: WorldZone[]
  roads: WorldRoad[]
  junctions: WorldJunction[]
  buildings: WorldBuilding[]
  landmarks: WorldLandmark[]
  green: Flat[]
  sand: Flat[]
  rail: Flat[]
  water: { ring: Flat; holes?: Flat[] }[]
  counts: Record<string, number>
  provenance: string[]
}

const cache = new Map<string, Promise<WorldData>>()

export function loadWorld(packId: string): Promise<WorldData> {
  let p = cache.get(packId)
  if (!p) {
    p = fetch(`/api/packs/${packId}/world`).then(async (r) => {
      if (!r.ok) throw new Error(`world.json for ${packId}: HTTP ${r.status} (run make_pack ${packId} --pack-only)`)
      return (await r.json()) as WorldData
    })
    cache.set(packId, p)
  }
  return p
}
