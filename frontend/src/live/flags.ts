// Per-agent alert flags recorded in the spare 16-bit row field (mirrors backend/cityshift/live/swarm.py).
export const FLAG_AWARE_MASK = 0b111
export const FLAG_RESPONDED = 1 << 3
export const FLAG_IN_ZONE = 1 << 4
export const FLAG_TRAPPED = 1 << 5
export const FLAG_FRESH = 1 << 6

/** 0 when the agent has not heard of any active incident; otherwise hop + 1 (1 = saw it). */
export function awareLevel(flags: number): number {
  return flags & FLAG_AWARE_MASK
}
