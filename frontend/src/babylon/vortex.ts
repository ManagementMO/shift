import { hash01, mix } from './geometry'
import type { SmokePuff } from './smoke'

export interface VortexShape {
  x: number
  z: number
  radius: number
  height: number
  direction: [number, number]
  seconds: number
  strength: number
  seed: number
}

const fade = (v: number): number => { const x = Math.max(0, Math.min(1, v)); return x * x * (3 - 2 * x) }
const SEEDS = Array.from({ length: 760 }, (_, i) => Array.from({ length: 7 }, (_, j) => hash01(`smoke:${i}:${j}`)))

export function vortexSmoke(v: VortexShape): SmokePuff[] {
  if (v.strength <= 0) return []
  const puffs: SmokePuff[] = []
  const elapsed = v.seconds
  for (let i = 0; i < 600; i++) {
    const [a, b, c, d, e, f, g] = SEEDS[i]
    const u = (a + elapsed * (0.07 + b * 0.05)) % 1
    const fringe = i >= 430
    const profile = v.radius * (0.07 + 0.25 * Math.sqrt(u) + 0.36 * u ** 3)
    const angle = d * Math.PI * 2 - elapsed * (2.1 + e * 1.6) / (0.4 + u * 0.85)
    const curl = 1 + 0.17 * Math.sin(angle * 3 + u * 19 - elapsed * 0.8)
    const orbit = profile * (fringe ? 0.95 + c * 0.5 : Math.sqrt(c) * 0.88) * curl
    const bendX = v.direction[0] * u * u * v.height * 0.12 + Math.sin(u * 5 + elapsed * 0.85 + v.seed * 5) * v.radius * 0.1 * u
    const bendZ = v.direction[1] * u * u * v.height * 0.12 + Math.cos(u * 4.2 + elapsed * 0.66) * v.radius * 0.09 * u
    const envelope = fade(u / 0.08) * fade((1 - u) / 0.22) * v.strength
    const size = v.radius * (0.15 + u * 0.26) * (0.7 + f * 0.65)
    const light = 0.68 + 0.32 * (0.5 + 0.5 * Math.cos(angle - 0.7))
    const color = mix([0.045, 0.05, 0.055], [0.22, 0.23, 0.23], u * 0.55 + g * 0.45)
    color[0] *= light
    color[1] *= light
    color[2] *= light
    puffs.push({
      x: v.x + bendX + Math.cos(angle) * orbit,
      y: 2 + u * v.height,
      z: v.z + bendZ + Math.sin(angle) * orbit,
      width: size * (fringe ? 0.72 : 1),
      height: size * (fringe ? 1.8 : 1.15),
      angle: angle * 0.3 + f * Math.PI,
      color,
      alpha: (fringe ? 0.17 : 0.48) * envelope * (0.75 + b * 0.25),
    })
  }
  for (let i = 600; i < SEEDS.length; i++) {
    const [a, b, c, d, e, f] = SEEDS[i]
    const age = (a + elapsed * (0.16 + b * 0.14)) % 1
    const angle = c * Math.PI * 2 - elapsed * (0.8 + d * 1.1)
    const radius = v.radius * (0.12 + 0.82 * age)
    const size = v.radius * (0.12 + age * 0.22) * (0.7 + e * 0.6)
    puffs.push({
      x: v.x + Math.cos(angle) * radius,
      y: 2 + Math.sin(age * Math.PI) * (8 + 10 * f),
      z: v.z + Math.sin(angle) * radius,
      width: size * 1.5,
      height: size * 0.8,
      angle: c * Math.PI * 2 + elapsed * 0.16,
      color: mix([0.31, 0.27, 0.22], [0.53, 0.47, 0.38], e),
      alpha: 0.36 * fade(age / 0.15) * (1 - age) ** 1.1 * v.strength,
    })
  }
  return puffs
}
