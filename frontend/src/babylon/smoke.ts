import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import type { Scene } from '@babylonjs/core/scene'
import type { RGB } from './geometry'

export interface SmokePuff {
  x: number
  y: number
  z: number
  width: number
  height: number
  angle: number
  color: RGB
  alpha: number
}

export type ProjectEffect = (x: number, y: number, z: number) => { x: number; y: number }
export type EffectBounds = { left: number; right: number; top: number; bottom: number }
const clamp = (v: number) => Math.max(0, Math.min(1, v))
const fade = (v: number) => { const x = clamp(v); return x * x * (3 - 2 * x) }

function lattice(x: number, y: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  const u = fade(x - ix), v = fade(y - iy)
  const a = lattice(ix, iy), b = lattice(ix + 1, iy)
  const c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1)
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v
}

function fbm(x: number, y: number): number {
  let value = 0, weight = 0.53
  for (let octave = 0; octave < 5; octave++) {
    value += noise(x, y) * weight
    x = x * 2.03 + 19.7
    y = y * 2.07 + 7.3
    weight *= 0.49
  }
  return value
}

export function smokeTexturePixels(size = 128, ground = false): Uint8Array {
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / (size - 1) * 2 - 1, v = y / (size - 1) * 2 - 1
    const distance = Math.hypot(u * 1.03, v * 0.98)
    const detail = ground ? 1 : fbm(u * 3.8 + 12.7, v * 3.8 + 9.4)
    const broad = ground ? 1 : fbm(u * 1.7 + 7.2, v * 1.7 + 31.1)
    const edge = ground ? Math.exp(-4.5 * distance * distance) * fade((0.96 - distance) / 0.28) : fade((0.96 - distance) / 0.48)
    const density = ground ? 1 : fade((detail * 0.68 + broad * 0.32 - 0.16) / 0.62)
    const shade = ground ? 255 : Math.round(255 * (0.45 + detail * 0.5))
    const i = (y * size + x) * 4
    pixels[i] = pixels[i + 1] = pixels[i + 2] = shade
    pixels[i + 3] = Math.round(255 * edge * density)
  }
  return pixels
}

const pixels = new Map<boolean, Uint8Array>()
const VERTEX = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
attribute vec4 smokeTint;
#ifdef INSTANCES
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
#endif
uniform mat4 world;
uniform mat4 view;
uniform mat4 viewProjection;
uniform float ground;
varying vec2 vUV;
varying vec4 vTint;
void main(void) {
#ifdef INSTANCES
  vec3 centre = (world * vec4(world3.xyz, 1.0)).xyz;
  vec2 offset = vec2(world0.x * position.x + world1.x * position.y, world0.y * position.x + world1.y * position.y);
#else
  vec3 centre = world[3].xyz;
  vec2 offset = position.xy;
#endif
  vec3 right = ground > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(view[0][0], view[1][0], view[2][0]);
  vec3 up = ground > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(view[0][1], view[1][1], view[2][1]);
  gl_Position = viewProjection * vec4(centre + right * offset.x + up * offset.y, 1.0);
  vUV = uv;
  vTint = smokeTint;
}`
const FRAGMENT = `
precision highp float;
varying vec2 vUV;
varying vec4 vTint;
uniform sampler2D smokeSampler;
uniform float ground;
void main(void) {
  vec4 sampleValue = texture2D(smokeSampler, vUV);
  float opacity = sampleValue.a * vTint.a;
  if (opacity < 0.002) discard;
  float shade = ground > 0.5 ? 1.0 : 0.62 + sampleValue.r * 0.55 + (1.0 - vUV.y) * 0.12;
  gl_FragColor = vec4(pow(vTint.rgb * shade, vec3(2.2)), opacity);
}`

export class SmokeSprites {
  readonly mesh: Mesh
  private readonly scene: Scene
  private readonly texture: RawTexture
  private readonly material: ShaderMaterial
  private matrices = new Float32Array(0)
  private tints = new Float32Array(0)
  private capacity = 0
  private puffs: SmokePuff[] = []

  constructor(scene: Scene, name: string, ground = false) {
    this.scene = scene
    this.mesh = new Mesh(name, scene)
    const quad = new VertexData()
    quad.positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]
    quad.uvs = [0, 0, 1, 0, 1, 1, 0, 1]
    quad.indices = [0, 1, 2, 0, 2, 3]
    quad.applyToMesh(this.mesh)
    let data = pixels.get(ground)
    if (!data) { data = smokeTexturePixels(128, ground); pixels.set(ground, data) }
    this.texture = RawTexture.CreateRGBATexture(data, 128, 128, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
    this.texture.name = `${name}-texture`
    this.texture.wrapU = this.texture.wrapV = Texture.CLAMP_ADDRESSMODE
    this.texture.hasAlpha = true
    this.material = new ShaderMaterial(`${name}-material`, scene, { vertexSource: VERTEX, fragmentSource: FRAGMENT }, {
      attributes: ['position', 'uv', 'smokeTint'], uniforms: ['world', 'view', 'viewProjection', 'ground'], samplers: ['smokeSampler'], needAlphaBlending: true,
    })
    this.material.setTexture('smokeSampler', this.texture)
    this.material.setFloat('ground', ground ? 1 : 0)
    this.material.backFaceCulling = false
    this.material.disableDepthWrite = true
    this.mesh.material = this.material
    this.mesh.alphaIndex = ground ? 0 : 3
    this.mesh.isPickable = false
    this.mesh.alwaysSelectAsActiveMesh = true
    this.mesh.doNotSyncBoundingInfo = true
    this.mesh.thinInstanceEnablePicking = false
    this.mesh.setEnabled(false)
  }

  draw(puffs: SmokePuff[]): void {
    this.puffs = puffs
    this.mesh.setEnabled(puffs.length > 0)
    if (!puffs.length) return
    if (puffs.length > this.capacity) {
      this.capacity = Math.max(puffs.length, 64, Math.ceil(this.capacity * 1.5))
      this.matrices = new Float32Array(this.capacity * 16)
      this.tints = new Float32Array(this.capacity * 4)
      this.mesh.thinInstanceSetBuffer('matrix', this.matrices, 16, false)
      this.mesh.thinInstanceSetBuffer('smokeTint', this.tints, 4, false)
    }
    const camera = this.scene.activeCamera?.globalPosition
    if (camera) {
      const distance = (p: SmokePuff) => (p.x - camera.x) ** 2 + (p.y - camera.y) ** 2 + (p.z - camera.z) ** 2
      puffs.sort((a, b) => distance(b) - distance(a))
    }
    puffs.forEach((p, i) => {
      const o = i * 16, c = Math.cos(p.angle), s = Math.sin(p.angle)
      this.matrices[o] = c * p.width
      this.matrices[o + 1] = s * p.width
      this.matrices[o + 4] = -s * p.height
      this.matrices[o + 5] = c * p.height
      this.matrices[o + 10] = 1
      this.matrices[o + 12] = p.x
      this.matrices[o + 13] = p.y
      this.matrices[o + 14] = p.z
      this.matrices[o + 15] = 1
      this.tints.set([...p.color, p.alpha], i * 4)
    })
    this.mesh.thinInstanceCount = puffs.length
    this.mesh.thinInstanceBufferUpdated('matrix')
    this.mesh.thinInstanceBufferUpdated('smokeTint')
  }

  bounds(project: ProjectEffect): EffectBounds | null {
    const boxes = this.screenBoxes(project)
    if (!boxes.length) return null
    return { left: Math.min(...boxes.map((b) => b.left)), right: Math.max(...boxes.map((b) => b.right)), top: Math.min(...boxes.map((b) => b.top)), bottom: Math.max(...boxes.map((b) => b.bottom)) }
  }

  hit(x: number, y: number, project: ProjectEffect): boolean {
    return this.screenBoxes(project).some((b) => {
      const rx = (b.right - b.left) / 2, ry = (b.bottom - b.top) / 2
      return rx > 0 && ry > 0 && ((x - (b.left + b.right) / 2) / rx) ** 2 + ((y - (b.top + b.bottom) / 2) / ry) ** 2 < 0.64
    })
  }

  private screenBoxes(project: ProjectEffect): EffectBounds[] {
    const camera = this.scene.activeCamera
    if (!camera) return []
    const m = camera.getViewMatrix().m
    return this.puffs.flatMap((p) => {
      if (p.alpha < 0.04) return []
      const depth = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14]
      if ((this.scene.useRightHandedSystem ? -depth : depth) <= 0) return []
      const c = Math.abs(Math.cos(p.angle)), s = Math.abs(Math.sin(p.angle))
      const w = (c * p.width + s * p.height) / 2, h = (s * p.width + c * p.height) / 2
      const center = project(p.x, p.y, p.z)
      const right = project(p.x + m[0] * w, p.y + m[4] * w, p.z + m[8] * w)
      const top = project(p.x + m[1] * h, p.y + m[5] * h, p.z + m[9] * h)
      const rx = Math.abs(right.x - center.x), ry = Math.abs(top.y - center.y)
      return [center.x, center.y, rx, ry].every(Number.isFinite) ? [{ left: center.x - rx, right: center.x + rx, top: center.y - ry, bottom: center.y + ry }] : []
    })
  }

  dispose(): void {
    this.puffs = []
    this.mesh.dispose()
    this.material.dispose()
    this.texture.dispose()
  }
}
