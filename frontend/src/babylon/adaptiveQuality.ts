/**
 * HD rendering (2x resolution, 4x MSAA) is the default, but a machine that cannot hold it renders the city at
 * 10 fps. Once the city is on screen we sample the frame rate; if it stays low, HD switches off and the choice is
 * remembered on this browser so the next visit starts fast. Turning HD back on in Settings clears the memory.
 */

import type { WorldScene } from './scene'

export const HD_MEMORY_KEY = 'cityshift.hd'
/** Below this sustained frame rate HD is not worth it. */
export const HD_MIN_FPS = 28
const SAMPLE_MS = 800
const SAMPLES = 5

export function rememberedSharp(): boolean | null {
  try {
    const value = localStorage.getItem(HD_MEMORY_KEY)
    return value === 'off' ? false : value === 'on' ? true : null
  } catch { return null }
}

export function rememberSharp(sharp: boolean): void {
  try { localStorage.setItem(HD_MEMORY_KEY, sharp ? 'on' : 'off') } catch { /* private mode */ }
}

/** Pure decision: drop HD when the median of the sampled frame rates is under the floor. */
export function shouldDropHd(fps: readonly number[], floor = HD_MIN_FPS): boolean {
  if (fps.length < SAMPLES) return false
  const sorted = [...fps].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] < floor
}

/**
 * Sample the frame rate while `active()` and call `onDrop` once if HD cannot be sustained. Returns a disposer.
 * Sampling starts fresh whenever the scene becomes active so a hidden or still-loading city is never judged.
 */
export function watchFrameRate(ws: WorldScene, active: () => boolean, sharp: () => boolean, onDrop: () => void): () => void {
  const samples: number[] = []
  const timer = window.setInterval(() => {
    if (!sharp()) { samples.length = 0; return }
    if (!active() || ws.scene.isDisposed) { samples.length = 0; return }
    samples.push(ws.engine.getFps())
    if (samples.length > SAMPLES) samples.shift()
    if (shouldDropHd(samples)) {
      samples.length = 0
      onDrop()
    }
  }, SAMPLE_MS)
  return () => window.clearInterval(timer)
}
