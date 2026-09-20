import { Material } from '@babylonjs/core/Materials/material'
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase'
import { MaterialPluginEvent } from '@babylonjs/core/Materials/materialPluginEvent'
import { PBRBaseMaterial } from '@babylonjs/core/Materials/PBR/pbrBaseMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer'
import type { SubMesh } from '@babylonjs/core/Meshes/subMesh'
import type { Observer } from '@babylonjs/core/Misc/observable'
import type { Scene } from '@babylonjs/core/scene'
import { insideLaser, MAX_LASER_STRIKES, type LaserCircle } from './orbitalLaserModel'

const slots = Array.from({ length: MAX_LASER_STRIKES }, (_, i) => `orbitalCut${i}`)

class OrbitalErasure extends MaterialPluginBase {
  private readonly erasure: CityErasure

  constructor(material: StandardMaterial | PBRBaseMaterial, erasure: CityErasure) {
    super(material, 'OrbitalErasure', 190)
    this.erasure = erasure
    this.registerForExtraEvents = true
    this._enable(true)
  }

  getClassName(): string { return 'OrbitalErasure' }

  getUniforms() {
    return {
      ubo: [{ name: 'orbitalClipEnabled', size: 1, type: 'float' }, ...slots.map(name => ({ name, size: 4, type: 'vec4' }))],
      fragment: `\n#ifndef UNIFORMBUFFERS\nuniform float orbitalClipEnabled;\n${slots.map(name => `uniform vec4 ${name};`).join('\n')}\n#endif\n`,
    }
  }

  hardBindForSubMesh(uniforms: UniformBuffer, _scene: Scene, _engine: unknown, subMesh: SubMesh): void {
    const mesh = subMesh.getRenderingMesh()
    const exempt = mesh.metadata?.cityTraffic || mesh.metadata?.development_id || mesh.name.startsWith('development-')
    uniforms.updateFloat('orbitalClipEnabled', !exempt && this.erasure.circles.length ? 1 : 0)
    for (let i = 0; i < slots.length; i++) {
      const circle = this.erasure.circles[i]
      uniforms.updateFloat4(slots[i], circle?.x ?? 0, circle?.z ?? 0, circle?.radius ?? 0, circle ? 1 : 0)
    }
  }

  getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return {
      CUSTOM_FRAGMENT_MAIN_BEGIN: `
if (orbitalClipEnabled > 0.5) {
${slots.map(name => `  if (${name}.w > 0.5 && dot(vPositionW.xz - ${name}.xy, vPositionW.xz - ${name}.xy) <= ${name}.z * ${name}.z) discard;`).join('\n')}
}
`,
    }
  }
}

export class CityErasure {
  circles: readonly LaserCircle[] = []
  private readonly observer: Observer<Material> | null

  constructor(scene: Scene) {
    const attach = (material: Material) => {
      if (material.getScene() !== scene || material.name === 'sky') return
      if (!(material instanceof StandardMaterial || material instanceof PBRBaseMaterial)) return
      if (!material.pluginManager?.getPlugin('OrbitalErasure')) new OrbitalErasure(material, this)
    }
    for (const material of scene.materials) attach(material)
    this.observer = Material.OnEventObservable.add(attach, MaterialPluginEvent.Created)
    scene.onDisposeObservable.addOnce(() => this.dispose())
  }

  contains(x: number, z: number): boolean {
    return this.circles.some(circle => insideLaser(circle, x, z))
  }

  dispose(): void {
    this.circles = []
    Material.OnEventObservable.remove(this.observer)
  }
}
