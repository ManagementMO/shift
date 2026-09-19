import type { WorldBuilding } from './worldData'

export const TEXTURE_RECIPES = {
  glass: { metres: [8, 12.8], specular: 0.22 },
  masonry: { metres: [9, 12.8], specular: 0.12 },
  brick: { metres: [8, 6.4], specular: 0.08 },
  industrial: { metres: [12, 8], specular: 0.2 },
  roof: { metres: [12, 12], specular: 0.08 },
  asphalt: { metres: [8, 8], specular: 0.03 },
  pavement: { metres: [4, 4], specular: 0.04 },
  grass: { metres: [18, 18], specular: 0.01 },
  sand: { metres: [8, 8], specular: 0.02 },
  concrete: { metres: [8, 8], specular: 0.1 },
  water: { metres: [48, 48], specular: 0.24 },
} as const

export type TextureKind = keyof typeof TEXTURE_RECIPES
export type FacadeKind = 'glass' | 'masonry' | 'brick' | 'industrial'

export function facadeFor(b: Pick<WorldBuilding, 'cat' | 'h'>): FacadeKind {
  if (b.cat === 'industrial' || b.cat === 'utility') return 'industrial'
  if (b.cat === 'tower' || b.cat === 'office' || b.h >= 75) return 'glass'
  if (b.cat === 'residential' || b.cat === 'retail') return 'brick'
  return 'masonry'
}

function noise(x: number, y: number): number {
  let h = Math.imul(x + 17, 374761393) ^ Math.imul(y + 37, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const fract = (x: number) => x - Math.floor(x)

export function texturePixels(kind: TextureKind, size = 256): Uint8Array {
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      const grain = (noise(x, y) - 0.5) * 12
      let r = 235, g = 233, b = 227
      if (kind === 'glass') {
        const cx = fract(u * 4), cy = fract(v * 4)
        const variation = noise(Math.floor(u * 4), Math.floor(v * 4)) * 24
        const reflection = cy * 16
        r = 140 + variation + reflection; g = 176 + variation + reflection; b = 193 + variation + reflection
        if (cy < 0.17) { r = 106; g = 137; b = 152 }
        if (cx < 0.035 || cy < 0.025) { r = 219; g = 222; b = 215 }
      } else if (kind === 'brick' || kind === 'masonry') {
        const brick = kind === 'brick'
        if (brick) {
          const row = Math.floor(v * 32)
          const mortar = fract(v * 32) < 0.08 || fract(u * 16 + (row % 2) * 0.5) < 0.06
          r = mortar ? 198 : 198 + grain; g = mortar ? 178 : 140 + grain; b = mortar ? 153 : 108 + grain
        }
        const cx = fract(u * 3), cy = fract(v * (brick ? 2 : 4))
        if (cx > 0.2 && cx < 0.8 && cy > 0.24 && cy < 0.85) {
          const reflection = noise(Math.floor(u * 3), Math.floor(v * 4)) * 40
          r = 115 + reflection; g = 133 + reflection; b = 144 + reflection
          if (Math.abs(cx - 0.5) < 0.015 || Math.abs(cy - 0.56) < 0.016) { r = 179; g = 182; b = 171 }
        } else if (cy > 0.19 && cy < 0.25 && cx > 0.16 && cx < 0.84) {
          r = 248; g = 238; b = 217
        }
      } else if (kind === 'industrial') {
        const rib = fract(u * 32) < 0.12 ? -26 : 0
        r = 224 + rib; g = 227 + rib; b = 225 + rib
        if (v > 0.65 && v < 0.82) { r = 95; g = 123; b = 135 }
      } else if (kind === 'roof') {
        const seam = fract(u * 4) < 0.016 || fract(v * 4) < 0.016 ? -30 : 0
        r = 207 + seam; g = 211 + seam; b = 213 + seam
      } else if (kind === 'pavement') {
        const seam = fract(u * 4) < 0.025 || fract(v * 4) < 0.025 ? -35 : 0
        r = 240 + seam; g = 237 + seam; b = 226 + seam
      } else if (kind === 'asphalt') {
        r = 226 + grain; g = 228 + grain; b = 230 + grain
      } else if (kind === 'grass') {
        const patch = 12 * Math.sin(u * Math.PI * 4) * Math.sin(v * Math.PI * 6)
        r = 212 + patch; g = 237 + patch; b = 194 + patch
      } else if (kind === 'sand') {
        r = 249; g = 237; b = 208
      } else if (kind === 'water') {
        const ripple = Math.sin((u * 6 + Math.sin(v * Math.PI * 4) * 0.15) * Math.PI * 2) * 3 + Math.sin((u * 3 + v * 2) * Math.PI * 2) * 2
        r = 212 + ripple; g = 237 + ripple; b = 245 + ripple
      }
      const i = (y * size + x) * 4
      pixels[i] = Math.max(0, Math.min(255, r + grain))
      pixels[i + 1] = Math.max(0, Math.min(255, g + grain))
      pixels[i + 2] = Math.max(0, Math.min(255, b + grain))
      pixels[i + 3] = 255
    }
  }
  return pixels
}
