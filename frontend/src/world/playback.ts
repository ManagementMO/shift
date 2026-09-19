// Simulation playback clock. Runs outside React: the world renderer reads `clock.t` every animation
// frame, while UI components subscribe at a throttled rate so no React tree re-renders per frame.

type Listener = (t: number) => void

const UI_HZ = 10
export const PLAYBACK_SPEEDS = [1, 2, 4, 8]

class PlaybackClock {
  t = 0
  playing = false
  speed = 1
  horizon = 2700
  private frameListeners = new Set<Listener>()
  private uiListeners = new Set<Listener>()
  private raf = 0
  private last = 0
  private lastUi = 0

  seek(t: number) {
    this.t = Math.max(0, Math.min(this.horizon, t))
    this.emit(true)
  }

  setHorizon(h: number) {
    this.horizon = Math.max(1, h)
    if (this.t > this.horizon) this.t = this.horizon
    this.emit(true)
  }

  setSpeed(s: number) {
    this.speed = s
    this.emit(true)
  }

  play() {
    if (this.playing) return
    if (this.t >= this.horizon) this.t = 0
    this.playing = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.step)
    this.emit(true)
  }

  pause() {
    this.playing = false
    cancelAnimationFrame(this.raf)
    this.emit(true)
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  onFrame(l: Listener) {
    this.frameListeners.add(l)
    return () => void this.frameListeners.delete(l)
  }

  onUi(l: Listener) {
    this.uiListeners.add(l)
    return () => void this.uiListeners.delete(l)
  }

  private step = (now: number) => {
    const dt = (now - this.last) / 1000
    this.last = now
    this.t = Math.min(this.horizon, this.t + dt * this.speed)
    if (this.t >= this.horizon) {
      this.playing = false
      this.emit(true)
      return
    }
    this.emit(false)
    this.raf = requestAnimationFrame(this.step)
  }

  private emit(force: boolean) {
    for (const l of this.frameListeners) l(this.t)
    const now = performance.now()
    if (force || now - this.lastUi > 1000 / UI_HZ) {
      this.lastUi = now
      for (const l of this.uiListeners) l(this.t)
    }
  }
}

export const clock = new PlaybackClock()

/** Simulated wall-clock label. The flagship egress is anchored at 22:30 (event end) by convention. */
export const SIM_ORIGIN_MIN = 22 * 60 + 30

export function simClock(t: number, seconds = false): string {
  const total = (SIM_ORIGIN_MIN * 60 + Math.floor(t)) % (24 * 60 * 60)
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const label = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  return seconds ? `${label}:${String(total % 60).padStart(2, '0')}` : label
}
