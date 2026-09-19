import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { Camera } from '@babylonjs/core/Cameras/camera'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { PBRBaseMaterial } from '@babylonjs/core/Materials/PBR/pbrBaseMaterial'
import { Material } from '@babylonjs/core/Materials/material'
import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase'
import { MaterialPluginEvent } from '@babylonjs/core/Materials/materialPluginEvent'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture'
import type { UniformBuffer } from '@babylonjs/core/Materials/uniformBuffer'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Scene } from '@babylonjs/core/scene'

import type { WorldCrs } from './coords'
import { SKY_RADIUS } from './sky'

type Bounds = WorldCrs['bounds_world']
type FadeRange = [start: number, end: number, edgeWidth: number]

export function worldFadeRange(bounds: Bounds, radius: number, maxZ: number): FadeRange {
  const span = Math.max(1, Math.min(bounds[2] - bounds[0], bounds[3] - bounds[1]))
  return [Math.min(radius + span * 0.25, maxZ * 0.6), Math.min(radius + span, maxZ * 0.85), span * 0.1]
}

interface AtmosphereState {
  bounds: Bounds
  range: FadeRange
  texture: BaseTexture
  direction: Vector3
  orthographic: boolean
}

class WorldAtmosphere extends MaterialPluginBase {
  private readonly state: AtmosphereState

  constructor(material: StandardMaterial | PBRBaseMaterial, state: AtmosphereState) {
    super(material, 'WorldAtmosphere', 200)
    this.state = state
    this.registerForExtraEvents = true
    this._enable(true)
  }

  getClassName(): string {
    return 'WorldAtmosphere'
  }

  getUniforms() {
    return {
      ubo: [
        { name: 'worldFadeBounds', size: 4, type: 'vec4' },
        { name: 'worldFadeRange', size: 3, type: 'vec3' },
        { name: 'worldSkyView', size: 4, type: 'vec4' },
      ],
      fragment: `
#ifndef UNIFORMBUFFERS
uniform vec4 worldFadeBounds;
uniform vec3 worldFadeRange;
uniform vec4 worldSkyView;
#endif
`,
    }
  }

  getSamplers(samplers: string[]): void {
    samplers.push('worldSkySampler')
  }

  getActiveTextures(textures: BaseTexture[]): void {
    textures.push(this.state.texture)
  }

  hasTexture(texture: BaseTexture): boolean {
    return texture === this.state.texture
  }

  hardBindForSubMesh(uniforms: UniformBuffer): void {
    uniforms.updateFloat4('worldFadeBounds', ...this.state.bounds)
    uniforms.updateFloat3('worldFadeRange', ...this.state.range)
    const { direction, orthographic } = this.state
    uniforms.updateFloat4('worldSkyView', direction.x, direction.y, direction.z, orthographic ? 1 : 0)
    uniforms.setTexture('worldSkySampler', this.state.texture)
  }

  getCustomCode(shaderType: string): Record<string, string> | null {
    if (shaderType !== 'fragment') return null
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: 'uniform sampler2D worldSkySampler;',
      CUSTOM_FRAGMENT_BEFORE_FOG: `
vec2 worldEdge = min(vPositionW.xz - worldFadeBounds.xy, worldFadeBounds.zw - vPositionW.xz);
float edgeFade = 1.0 - smoothstep(0.0, worldFadeRange.z, min(worldEdge.x, worldEdge.y));
float distanceFade = smoothstep(worldFadeRange.x, worldFadeRange.y, length(vPositionW - vEyePosition.xyz));
float worldFade = 1.0 - (1.0 - edgeFade) * (1.0 - distanceFade);
vec3 skyOffset = vPositionW - vEyePosition.xyz;
vec3 skyDirection = normalize(skyOffset);
if (worldSkyView.w > 0.5) {
  vec3 perpendicular = skyOffset - worldSkyView.xyz * dot(skyOffset, worldSkyView.xyz);
  float skyDepth = sqrt(max(0.0, ${SKY_RADIUS * SKY_RADIUS}.0 - dot(perpendicular, perpendicular)));
  skyDirection = normalize(perpendicular + worldSkyView.xyz * skyDepth);
}
vec2 skyUV = vec2(fract(atan(skyDirection.z, skyDirection.x) / 6.28318530718), asin(clamp(skyDirection.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
vec3 skyColor = texture2D(worldSkySampler, skyUV).rgb;
#ifdef PBR_FRAGMENT_SHADER
finalColor.rgb = mix(finalColor.rgb, toLinearSpace(skyColor), worldFade);
#else
color.rgb = mix(color.rgb, skyColor, worldFade);
#endif
`,
    }
  }
}

export function applyWorldAtmosphere(scene: Scene, bounds: Bounds, sky: Mesh): void {
  scene.fogMode = Scene.FOGMODE_NONE
  const skyMaterial = sky.material as StandardMaterial
  const forward = Vector3.Forward()
  const state: AtmosphereState = {
    bounds: [...bounds], range: worldFadeRange(bounds, 0, 40000), texture: skyMaterial.emissiveTexture!,
    direction: Vector3.Forward(), orthographic: false,
  }
  const update = () => {
    const camera = scene.activeCamera
    if (!camera) return
    state.range = worldFadeRange(bounds, camera instanceof ArcRotateCamera ? camera.radius : 0, camera.maxZ)
    camera.getDirectionToRef(forward, state.direction)
    state.direction.normalize()
    state.orthographic = camera.mode === Camera.ORTHOGRAPHIC_CAMERA
  }
  update()
  scene.onBeforeRenderObservable.add(update)
  const attach = (material: Material) => {
    if (material.getScene() !== scene || material === skyMaterial) return
    if (!(material instanceof StandardMaterial || material instanceof PBRBaseMaterial)) return
    if (!material.pluginManager?.getPlugin('WorldAtmosphere')) new WorldAtmosphere(material, state)
  }
  for (const material of scene.materials) attach(material)
  const observer = Material.OnEventObservable.add(attach, MaterialPluginEvent.Created)
  scene.onDisposeObservable.addOnce(() => Material.OnEventObservable.remove(observer))
}
