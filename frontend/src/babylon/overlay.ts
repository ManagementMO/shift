/**
 * Scenario marks drawn over the static city: closed edges (active restriction), ghost edges / stops of an
 * unconfirmed proposal, and focus corridors.  Rebuilt only when the set of marked ids changes.
 */

import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Scene } from '@babylonjs/core/scene'

import { hex, meshFromBatch, vertexColorMaterial, Y } from './city'
import type { WorldFrame } from './coords'
import { Batch, type RGB } from './geometry'
import type { RoadIndex } from './roadIndex'

export const MARK: Record<'closed' | 'ghost' | 'focus' | 'ghostStop', RGB> = {
  closed: hex('#d7263d'),
  ghost: hex('#22b8cf'),
  focus: hex('#eca840'),
  ghostStop: hex('#22b8cf'),
}

export interface Marks {
  closed: Iterable<string>
  ghost: Iterable<string>
  focus: Iterable<string>
  ghostStops: { lon: number; lat: number }[]
}

const Y_MARK = Y.junction + 0.08

export class Overlay {
  private readonly scene: Scene
  private readonly roads: RoadIndex
  private readonly frame: WorldFrame
  private readonly mat: StandardMaterial
  private mesh: Mesh | null = null
  private key = ''

  constructor(scene: Scene, roads: RoadIndex, frame: WorldFrame) {
    this.scene = scene
    this.roads = roads
    this.frame = frame
    this.mat = vertexColorMaterial('overlay-mat', scene, 0)
    this.mat.emissiveColor.set(0.35, 0.35, 0.35)
  }

  set(m: Marks): void {
    const closed = [...m.closed].sort()
    const ghost = [...m.ghost].sort()
    const focus = [...m.focus].sort()
    const key = `${closed.join(',')}|${ghost.join(',')}|${focus.join(',')}|${m.ghostStops.map((s) => `${s.lon},${s.lat}`).join(';')}`
    if (key === this.key) return
    this.key = key
    this.mesh?.dispose()
    this.mesh = null
    if (!closed.length && !ghost.length && !focus.length && !m.ghostStops.length) return
    const b = new Batch()
    const drawn = new Set<string>()
    const edges = (ids: string[], c: RGB, extra: number, lift: number): void => {
      for (const id of ids) {
        if (drawn.has(id)) continue
        drawn.add(id)
        const r = this.roads.byId.get(id)
        if (r) b.ribbon(r.shape, r.w + extra, Y_MARK + lift, c)
      }
    }
    edges(focus, MARK.focus, 1.5, 0.08)
    edges(ghost, MARK.ghost, 2.5, 0.04)
    edges(closed, MARK.closed, 2.5, 0)
    for (const s of m.ghostStops) {
      const [x, z] = this.frame.lonLatToWorld(s.lon, s.lat)
      b.disc(x, z, 5, Y.stop + 0.05, MARK.ghostStop, 16)
    }
    if (!b.vertexCount) return
    this.mesh = meshFromBatch('overlay', b, this.scene, this.mat)
  }

  dispose(): void {
    this.mesh?.dispose()
    this.mat.dispose()
  }
}
