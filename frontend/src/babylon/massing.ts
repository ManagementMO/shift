import { Batch, centroid, signedArea, hash01, type RGB } from './geometry'
import { interiorBox } from './details'
import type { BuildingCategory } from './worldData'

export interface MassingTier { y0: number; y1: number; ring: number[]; holes: number[][]; roofs?: { ring: number[]; holes?: number[][] }[] }
export interface MassingBuilding { id: string; cat: BuildingCategory; h: number; x: number; z: number; tiers: MassingTier[] }
export interface MassingAlignment { method: string; translation_m: [number, number]; area_coverage: number; sampled_footprints: number }
export interface MassingData { version: number; network_fingerprint: string; source: string; source_url: string; license: string; excluded_osm_ids: string[]; buildings: MassingBuilding[]; prepared?: boolean; alignment?: MassingAlignment }

/** Official roof-derived tiers in the same metre coordinates as the simulation. */
export function appendMassing(building: MassingBuilding, facade: Batch, roof: Batch, color: RGB): void {
  const highest = Math.max(...building.tiers.map(t => t.y1))
  const seed = hash01(building.id)
  const roofColor: RGB = seed > 0.7 ? [0.65, 0.63, 0.57] : seed > 0.3 ? [0.48, 0.49, 0.46] : [0.4, 0.44, 0.43]
  for (const tier of building.tiers) {
    facade.walls(tier.ring, tier.holes, tier.y0 + 0.3, tier.y1 + 0.3, color, 1)
    const roofs = tier.roofs ?? [{ ring: tier.ring, holes: tier.holes }]
    for (const area of roofs) roof.polygon(area.ring, area.holes, tier.y1 + 0.3, roofColor)
    if (tier.y1 !== highest || !roofs.length || Math.abs(signedArea(tier.ring)) < 100 || highest < 12) continue
    const top = tier.y1 + 0.3
    if (!tier.roofs) roof.walls(tier.ring, tier.holes, top, top + 0.5, [0.69, 0.68, 0.63], 1)
    const unit = roofs.map(area => interiorBox(area, highest > 50 ? 2.8 : 1.5)).find(Boolean)
    if (!unit) continue
    const h = highest > 50 ? 2.4 : 1.2
    roof.extrude(unit, undefined, top, top + h, [0.49, 0.52, 0.5], [0.7, 0.71, 0.67])
    const [x, z] = centroid(unit)
    roof.lathe(x, z, [[0.8, top + h], [0.8, top + h + 0.18]], [0.25, 0.29, 0.28], 8, 1)
  }
}
