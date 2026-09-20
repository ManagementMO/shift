import { describe, expect, it } from 'vitest'
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Scene } from '@babylonjs/core/scene'
import { developmentPreset } from '../development'
import { fixturePack } from '../development.fixtures'
import { hex } from './city'
import { WorldFrame } from './coords'
import { DevelopmentOverlay, developmentGeometry, type DevelopmentMarks } from './developments'

const frame = new WorldFrame({ utm_zone: 17, net_offset: [-626705.41, -4831652.88], origin_net: [3203.875, 2450.355], origin_lonlat: [-79.3891482, 43.6485798], bounds_world: [-3203.9, -2450.4, 3203.9, 2450.4] })

const idle: Pick<DevelopmentMarks, 'ghostPosition' | 'placed'> = { ghostPosition: null, placed: false }

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
    const draftAt: [number, number] = [-79.388, 43.644]
    const marks: DevelopmentMarks = { developments: [development], draft: { ...spec, position: draftAt }, ghostPosition: draftAt, placed: true, invalidDraft: false, focusedId: null, zones: fixturePack.zones, t: 0 }
    const before = JSON.stringify(development)
    overlay.set(marks)
    expect(scene.getMeshByName('development-draft')?.material?.alpha).toBeLessThan(1)
    expect(scene.getMeshByName('development-saved')?.metadata.development_id).toBe('saved')
    const saved = scene.getMeshByName('development-saved')
    overlay.set({ ...marks, t: 1 })
    expect(scene.getMeshByName('development-saved')).toBe(saved)
    overlay.set({ ...marks, draft: null, ...idle })
    expect(scene.getMeshByName('development-draft')).toBeNull()
    expect(scene.getMeshByName('development-saved')).not.toBeNull()
    expect(JSON.stringify(development)).toBe(before)
    overlay.animate(16)
    overlay.dispose()
    expect(scene.meshes).toHaveLength(0)
    expect(scene.transformNodes).toHaveLength(0)
    expect(scene.materials).toHaveLength(0)
    scene.dispose()
    engine.dispose()
  })

  it('glides the aimed ghost after the cursor without rebuilding its mesh, and hides it off the map', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const overlay = new DevelopmentOverlay(scene, frame)
    const spec = developmentPreset(fixturePack, 1800, 'skyscraper')
    const a: [number, number] = [-79.388, 43.644], b: [number, number] = [-79.384, 43.646]
    const marks: DevelopmentMarks = { developments: [], draft: spec, ghostPosition: a, placed: false, invalidDraft: false, focusedId: null, zones: fixturePack.zones, t: 0 }
    overlay.set(marks)
    const ghost = scene.getMeshByName('development-draft')!
    expect(ghost.parent?.isEnabled()).toBe(true)
    expect(overlay.ghostWorldTarget()).toEqual(frame.lonLatToWorld(...a))
    expect(scene.getMeshByName('development-intentions')).toBeNull() // no direction arrows until it is placed
    overlay.set({ ...marks, ghostPosition: b })
    expect(scene.getMeshByName('development-draft')).toBe(ghost) // same mesh: hovering never rebuilds geometry
    const target = frame.lonLatToWorld(...b)
    expect(overlay.ghostWorldTarget()).toEqual(target)
    const root = ghost.parent as TransformNode
    for (let i = 0; i < 60; i++) overlay.animate(50) // ~3 s of frames: the glide converges on the cursor
    const [ax, az] = frame.lonLatToWorld(...a)
    expect(root.position.x + ax).toBeCloseTo(target[0], 2)
    expect(root.position.z + az).toBeCloseTo(target[1], 2)
    overlay.set({ ...marks, ghostPosition: null })
    expect(root.isEnabled()).toBe(false)
    expect(overlay.ghostWorldTarget()).toBeNull()
    overlay.dispose()
    scene.dispose()
    engine.dispose()
  })

  it('rises a freshly placed footprint out of the ground and draws its direction arrows', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const overlay = new DevelopmentOverlay(scene, frame)
    const spec = developmentPreset(fixturePack, 1800, 'townhouse')
    const at: [number, number] = [-79.388, 43.644]
    overlay.set({ developments: [], draft: spec, ghostPosition: at, placed: false, invalidDraft: false, focusedId: null, zones: fixturePack.zones, t: 0 })
    overlay.set({ developments: [], draft: { ...spec, position: at }, ghostPosition: at, placed: true, invalidDraft: false, focusedId: null, zones: fixturePack.zones, t: 0 })
    const root = scene.getMeshByName('development-draft')!.parent as TransformNode
    expect(scene.getMeshByName('development-intentions')).not.toBeNull()
    expect(scene.getMeshByName('development-ripple')).not.toBeNull()
    overlay.animate(16)
    expect(root.scaling.y).toBeLessThan(0.5)
    for (let i = 0; i < 80; i++) overlay.animate(16)
    expect(root.scaling.y).toBe(1)
    expect(scene.getMeshByName('development-ripple')).toBeNull() // the ripple fades out and frees its material
    overlay.dispose()
    expect(scene.materials).toHaveLength(0)
    scene.dispose()
    engine.dispose()
  })

  it('renders a park as a flat grove, never a tower', () => {
    const park = developmentGeometry(developmentPreset(fixturePack, 1800, 'park'), frame, hex('#4f9a3c'))
    const tower = developmentGeometry(developmentPreset(fixturePack, 1800, 'apartment'), frame, hex('#178f83'))
    const ys = park.positions.filter((_, i) => i % 3 === 1)
    expect(park.vertexCount).toBeGreaterThan(tower.vertexCount) // lawn + paths + trees
    expect(Math.max(...ys)).toBeLessThan(12)
    expect(Math.max(...ys)).toBeGreaterThan(4) // trees have height
  })

  it('keeps the ground halo depth-tested so it never paints over the building walls', () => {
    const engine = new NullEngine()
    const scene = new Scene(engine)
    const overlay = new DevelopmentOverlay(scene, frame)
    const spec = developmentPreset(fixturePack, 1800)
    overlay.set({ developments: [{ development_id: 'saved', spec, access: [] }], draft: null, ...idle, invalidDraft: false, focusedId: 'saved', zones: fixturePack.zones, t: 0 })
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
