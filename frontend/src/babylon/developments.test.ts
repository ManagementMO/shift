import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { developmentPreset } from '../development'
import { fixturePack } from '../development.fixtures'
import { hex } from './city'
import { WorldFrame } from './coords'
import { DevelopmentOverlay, developmentGeometry } from './developments'

const frame = new WorldFrame({ utm_zone: 17, net_offset: [-626705.41, -4831652.88], origin_net: [3203.875, 2450.355], origin_lonlat: [-79.3891482, 43.6485798], bounds_world: [-3203.9, -2450.4, 3203.9, 2450.4] })

describe('scenario-local development meshes', () => {
  it('creates finite metre-aligned geometry without inferring demand from height', () => {
    const spec = developmentPreset(fixturePack, 1800)
    const before = JSON.stringify(spec)
    const batch = developmentGeometry(spec, frame, hex('#178f83'))
    expect(batch.vertexCount).toBeGreaterThan(20)
    expect(batch.positions.every(Number.isFinite)).toBe(true)
    const x = batch.positions.filter((_, i) => i % 3 === 0)
    const z = batch.positions.filter((_, i) => i % 3 === 2)
    expect(Math.max(...x) - Math.min(...x)).toBeCloseTo(spec.footprint_m[0] + 0.5)
    expect(Math.max(...z) - Math.min(...z)).toBeCloseTo(spec.footprint_m[1] + 0.5)
    expect(JSON.stringify(spec)).toBe(before)
  })

  it('removes only the draft on cancel and disposes all owned meshes and materials', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const overlay = new DevelopmentOverlay(scene, frame)
    const spec = developmentPreset(fixturePack, 1800)
    const development = { development_id: 'saved', spec, access: [] }
    const marks = { developments: [development], draft: { ...spec, position: [-79.388, 43.644] as [number, number] }, invalidDraft: false, focusedId: null, zones: fixturePack.zones, t: 0 }
    const before = JSON.stringify(development)
    overlay.set(marks)
    expect(scene.getMeshByName('development-draft')?.material?.alpha).toBeLessThan(1)
    expect(scene.getMeshByName('development-saved')?.metadata.development_id).toBe('saved')
    const saved = scene.getMeshByName('development-saved')
    overlay.set({ ...marks, t: 1 })
    expect(scene.getMeshByName('development-saved')).toBe(saved)
    overlay.set({ ...marks, draft: null })
    expect(scene.getMeshByName('development-draft')).toBeNull()
    expect(scene.getMeshByName('development-saved')).not.toBeNull()
    expect(JSON.stringify(development)).toBe(before)
    overlay.dispose()
    expect(scene.meshes).toHaveLength(0)
    expect(scene.materials).toHaveLength(0)
    scene.dispose()
    engine.dispose()
  })

  it('keeps the ground halo depth-tested so it never paints over the building walls', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const overlay = new DevelopmentOverlay(scene, frame)
    const spec = developmentPreset(fixturePack, 1800)
    overlay.set({ developments: [{ development_id: 'saved', spec, access: [] }], draft: null, invalidDraft: false, focusedId: 'saved', zones: fixturePack.zones, t: 0 })
    const halo = scene.getMeshByName('development-halos')
    expect(halo).not.toBeNull()
    expect(halo!.renderingGroupId).toBe(0)
    expect(scene.getMeshByName('development-saved')!.renderingGroupId).toBe(0)
    // Outline and direction cues stay always-on-top so a saved lot is legible through neighbouring towers.
    expect(scene.getMeshByName('development-footprints')!.renderingGroupId).toBe(1)
    expect(scene.getMeshByName('development-intentions')!.renderingGroupId).toBe(1)
    overlay.dispose()
    scene.dispose()
    engine.dispose()
  })

  it.each([NaN, Infinity, 1e300, -1, 0])('does not emit GPU geometry for invalid height %s', (height_m) => {
    const spec = { ...developmentPreset(fixturePack, 1800), height_m }
    expect(developmentGeometry(spec, frame, hex('#178f83')).isEmpty()).toBe(true)
  })
})
