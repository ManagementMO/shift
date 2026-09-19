import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Scene } from '@babylonjs/core/scene'

const WIDTH = 1024
const HEIGHT = 512
const HORIZON_ELEVATION = -0.6
let cachedSky: { horizon: Color3; pixels: Uint8Array } | null = null

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x + 17, 374761393) ^ Math.imul(y + 37, 668265263) ^ Math.imul(z + 53, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

function noise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const u = smooth(0, 1, x - ix), v = smooth(0, 1, y - iy), w = smooth(0, 1, z - iz)
  return lerp(
    lerp(lerp(hash(ix, iy, iz), hash(ix + 1, iy, iz), u), lerp(hash(ix, iy + 1, iz), hash(ix + 1, iy + 1, iz), u), v),
    lerp(lerp(hash(ix, iy, iz + 1), hash(ix + 1, iy, iz + 1), u), lerp(hash(ix, iy + 1, iz + 1), hash(ix + 1, iy + 1, iz + 1), u), v),
    w,
  )
}

function cloudNoise(x: number, y: number, z: number): number {
  let value = 0, weight = 0.5
  for (let octave = 0; octave < 5; octave++) {
    value += noise(x, y, z) * weight
    x = x * 2.03 + 13.7
    y = y * 2.03 + 9.3
    z = z * 2.03 + 17.1
    weight *= 0.5
  }
  return value / 0.96875
}

export function skyTexturePixels(horizon: Color3, width = WIDTH, height = HEIGHT): Uint8Array {
  const pixels = new Uint8Array(width * height * 4)
  const zenith = new Color3(0.47, 0.62, 0.84)
  for (let y = 0; y < height; y++) {
    const el = -Math.PI / 2 + (y / (height - 1)) * Math.PI
    const t = Math.max(0, (el - HORIZON_ELEVATION) / (Math.PI / 2 - HORIZON_ELEVATION)) // 0 = horizon (slightly below), 1 = zenith
    const clear = Color3.Lerp(horizon, zenith, Math.pow(t, 0.7))
    const haze = smooth(0.02, 0.24, t)
    const sy = Math.sin(el)
    const radius = y === 0 || y === height - 1 ? 0 : Math.cos(el)
    for (let x = 0; x < width; x++) {
      const angle = x === width - 1 ? 0 : (x / (width - 1)) * Math.PI * 2
      const sx = Math.cos(angle) * radius, sz = Math.sin(angle) * radius
      const density = cloudNoise(sx * 4.2 + 17.2, sy * 8.4 + 3.7, sz * 4.2 - 11.5)
      const wisps = smooth(0.56, 0.76, noise(sx * 16 + 8, sy * 40 + 20, sz * 16 - 8)) * 0.16
      const cloud = (smooth(0.43, 0.66, density) * 0.92 + wisps) * haze
      const coverage = Math.min(1, cloud)
      const light = smooth(0.46, 0.72, density)
      const glow = Math.pow(Math.max(0, (-0.5 * sx + 0.72 * sy - 0.42 * sz) / Math.hypot(0.5, 0.72, 0.42)), 12) * 0.08 * haze
      const grain = (hash(Math.floor(sx * 4096), Math.floor(sy * 4096), Math.floor(sz * 4096)) - 0.5) * haze / 255
      const i = (y * width + x) * 4
      pixels[i] = Math.round(Math.min(1, lerp(clear.r + glow, lerp(0.77, 0.995, light), coverage) + grain) * 255)
      pixels[i + 1] = Math.round(Math.min(1, lerp(clear.g + glow * 0.7, lerp(0.8, 0.98, light), coverage) + grain) * 255)
      pixels[i + 2] = Math.round(Math.min(1, lerp(clear.b + glow * 0.35, lerp(0.86, 0.955, light), coverage) + grain) * 255)
      pixels[i + 3] = 255
    }
  }
  return pixels
}

/** Gradient sky dome: pale warm horizon rising to a soft blue, unlit and always behind everything. */
export function buildSky(scene: Scene, horizon: Color3): Mesh {
  const rings = 32
  const segs = 64
  const r = 30000
  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  for (let j = 0; j <= rings; j++) {
    const v = j / rings
    const el = -Math.PI / 2 + v * Math.PI
    const y = Math.sin(el) * r
    const rr = Math.cos(el) * r
    for (let i = 0; i <= segs; i++) {
      const u = i / segs
      const a = u * Math.PI * 2
      positions.push(Math.cos(a) * rr, y, Math.sin(a) * rr)
      uvs.push(u, v)
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i
      const b = a + 1
      const c = a + segs + 1
      const d = c + 1
      indices.push(a, b, c, b, d, c)
    }
  }
  const sky = new Mesh('sky', scene)
  const vd = new VertexData()
  vd.positions = new Float32Array(positions)
  vd.uvs = new Float32Array(uvs)
  vd.indices = new Uint16Array(indices)
  vd.applyToMesh(sky)
  if (!cachedSky || !cachedSky.horizon.equals(horizon)) cachedSky = { horizon: horizon.clone(), pixels: skyTexturePixels(horizon) }
  const texture = RawTexture.CreateRGBATexture(cachedSky.pixels, WIDTH, HEIGHT, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE)
  texture.name = 'sky-clouds'
  texture.wrapU = Texture.WRAP_ADDRESSMODE
  texture.wrapV = Texture.CLAMP_ADDRESSMODE
  const m = new StandardMaterial('sky', scene)
  m.disableLighting = true
  m.emissiveTexture = texture
  m.diffuseColor = Color3.Black()
  m.specularColor = Color3.Black()
  m.backFaceCulling = false
  m.fogEnabled = false
  sky.material = m
  sky.infiniteDistance = true
  sky.isPickable = false
  sky.applyFog = false
  sky.renderingGroupId = 0
  return sky
}
