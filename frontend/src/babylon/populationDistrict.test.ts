import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { describe, expect, it } from 'vitest'
import { populationArtifact } from '../population.testData'
import { WorldFrame } from './coords'
import { PopulationDistrict, populationDistrictBounds } from './populationDistrict'

const frame = new WorldFrame({ utm_zone: 17, net_offset: [-626705.41, -4831652.88], origin_net: [3203.875, 2450.355], origin_lonlat: [-79.3891482, 43.6485798], bounds_world: [-3204, -2451, 3204, 2451] })

describe('native activity district', () => {
  it('bounds actual declared anchors with padding without moving or modifying them', () => {
    const definition = populationArtifact().definition
    const before = JSON.stringify(definition)
    const bounds = populationDistrictBounds(definition, frame)!
    for (const anchor of definition.anchors) {
      const [x, z] = frame.lonLatToWorld(anchor.lon, anchor.lat)
      expect(x).toBeGreaterThan(bounds[0]); expect(x).toBeLessThan(bounds[2])
      expect(z).toBeGreaterThan(bounds[1]); expect(z).toBeLessThan(bounds[3])
    }
    expect(JSON.stringify(definition)).toBe(before)
    expect(populationDistrictBounds({ ...definition, anchors: [] }, frame)).toBeNull()
  })

  it('only draws matching frozen definitions and disposes its outline without replacing city geometry', () => {
    const engine = new NullEngine(), scene = new Scene(engine)
    const building = new Mesh('existing-building', scene)
    const material = new StandardMaterial('existing-building-material', scene)
    building.material = material
    const district = new PopulationDistrict(scene, frame, 'net')
    const definition = populationArtifact().definition
    try {
      district.setDefinition(definition)
      const outline = scene.getMeshByName('population-activity-district')!
      expect(outline).not.toBeNull()
      expect(outline.isPickable).toBe(false)
      district.setDefinition(definition)
      expect(scene.getMeshByName('population-activity-district')).toBe(outline)
      district.setDefinition({ ...definition, network_fingerprint: 'different-network' })
      expect(outline.isDisposed()).toBe(true)
      expect(scene.getMeshByName('population-activity-district')).toBeNull()
      district.setDefinition(definition)
      district.setDefinition(null)
      expect(scene.getMeshByName('population-activity-district')).toBeNull()
      expect(building.material).toBe(material)
      expect(building.isDisposed()).toBe(false)
    } finally { district.dispose(); scene.dispose(); engine.dispose() }
  })
})
