import type { WorldBuilding } from './worldData'

export const TEXTURE_RECIPES = {
  glass: { metres: [12, 14.4], specular: 0.55 },
  curtain: { metres: [10, 14.4], specular: 0.65 },
  limestone: { metres: [12, 14.4], specular: 0.12 },
  balcony: { metres: [12, 12.8], specular: 0.3 },
  copper: { metres: [10, 14.4], specular: 0.45 },
  masonry: { metres: [9, 12.8], specular: 0.12 },
  brick: { metres: [8, 6.4], specular: 0.08 },
  industrial: { metres: [12, 8], specular: 0.2 },
  roof: { metres: [12, 12], specular: 0.08 },
  asphalt: { metres: [8, 8], specular: 0.03 },
  pavement: { metres: [4, 4], specular: 0.04 },
  grass: { metres: [18, 18], specular: 0.01 },
  sand: { metres: [8, 8], specular: 0.02 },
  concrete: { metres: [8, 8], specular: 0.1 },
  water: { metres: [48, 48], specular: 0.6 },
  darkglass: { metres: [12, 14.4], specular: 0.7 },
  precast: { metres: [10, 14.4], specular: 0.15 },
  terracotta: { metres: [10, 12.8], specular: 0.12 },
  stonebay: { metres: [12, 14.4], specular: 0.15 },
} as const

export type TextureKind = keyof typeof TEXTURE_RECIPES
export type FacadeKind = 'glass' | 'curtain' | 'limestone' | 'balcony' | 'copper' | 'masonry' | 'brick' | 'industrial' | 'darkglass' | 'precast' | 'terracotta' | 'stonebay'

export function facadeFor(b: Pick<WorldBuilding, 'cat' | 'h'> & { id?: string }): FacadeKind {
  if (b.cat === 'industrial' || b.cat === 'utility') return 'industrial'
  if (b.id) {
    const choice = Math.floor(noise(b.id.length, Array.from(b.id).reduce((a, c) => a + c.charCodeAt(0), 0)) * 9)
    if (b.h >= 65 || b.cat === 'office') return (['glass', 'curtain', 'limestone', 'darkglass', 'copper', 'curtain', 'balcony', 'precast', 'stonebay'] as const)[choice]
    if (b.cat === 'commercial' && b.h > 12) return choice % 2 ? 'terracotta' : 'stonebay'
    if ((b.cat === 'apartments' || b.cat === 'hotel') && b.h > 18) return 'balcony'
  }
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
      if (['glass', 'curtain', 'copper', 'limestone', 'balcony', 'darkglass', 'precast', 'terracotta', 'stonebay'].includes(kind)) {
        const cx = fract(u * 5), cy = fract(v * 4)
        const pane = noise(Math.floor(u * 5) + 13, Math.floor(v * 4) + 29)
        const reflected = Math.sin(u * 17 + pane * 2) * 14 + cy * 18
        const warm = kind === 'copper'
        r = (warm ? 121 : 91) + pane * 43 + reflected
        g = (warm ? 111 : 132) + pane * 43 + reflected
        b = (warm ? 88 : 151) + pane * 35 + reflected
        if (pane > 0.82) { r += 40; g += 26; b += 8 }
        const frame = kind === 'limestone' || kind === 'precast' || kind === 'terracotta' || kind === 'stonebay' ? cx < 0.23 || cy < 0.22 : cx < 0.065 || cy < 0.08
        if (frame) { r = warm ? 160 : 203; g = warm ? 150 : 205; b = warm ? 128 : 195 }
        if (kind === 'curtain' && cy > 0.77) { r *= 0.6; g *= 0.67; b *= 0.73 }
        if (kind === 'balcony') {
          if (cy < 0.1) { r = 229; g = 224; b = 210 }
          else if (cy < 0.23) { r = 59; g = 69; b = 73 }
          if (cx < 0.06) { r = 199; g = 202; b = 195 }
        }
        if (kind === 'darkglass') { r *= 0.67; g *= 0.72; b *= 0.73 }
        if (kind === 'precast' && frame) { r = 196; g = 188; b = 170 }
        if (kind === 'terracotta' && frame) { r = 179; g = 120; b = 84 }
        if (kind === 'stonebay') {
          if (frame) { r = 216; g = 204; b = 181 }
          if (cy < 0.05) { r = 134; g = 129; b = 114 }
        }
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
          r = 69 + reflection; g = 100 + reflection; b = 117 + reflection
          if (Math.abs(cx - 0.5) < 0.015 || Math.abs(cy - 0.56) < 0.016) { r = 179; g = 182; b = 171 }
        } else if (cy > 0.19 && cy < 0.25 && cx > 0.16 && cx < 0.84) {
          r = 248; g = 238; b = 217
        }
      } else if (kind === 'industrial') {
        const rib = fract(u * 32) < 0.12 ? -26 : 0
        r = 224 + rib; g = 227 + rib; b = 225 + rib
        if (v > 0.65 && v < 0.82) { r = 95; g = 123; b = 135 }
      } else if (kind === 'roof') {
        const seam = fract(u * 6) < 0.025 || fract(v * 6) < 0.025 ? -22 : 0
        r = 185 + seam + grain * 2; g = 185 + seam + grain * 2; b = 179 + seam + grain * 2
      } else if (kind === 'pavement') {
        const seam = fract(u * 4) < 0.025 || fract(v * 4) < 0.025 ? -35 : 0
        r = 240 + seam; g = 237 + seam; b = 226 + seam
      } else if (kind === 'asphalt') {
        r = 226 + grain; g = 228 + grain; b = 230 + grain
      } else if (kind === 'grass') {
        const patch = 20 * Math.sin(u * Math.PI * 4) * Math.sin(v * Math.PI * 6)
        r = 184 + patch; g = 207 + patch; b = 160 + patch
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
