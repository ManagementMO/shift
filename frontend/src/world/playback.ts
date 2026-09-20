// Simulation playback clock. Runs outside React: the world renderer reads `clock.t` every animation
// frame, while UI components subscribe at a throttled rate so no React tree re-renders per frame.

type Listener = (t: number) => void

const UI_HZ = 10

export class PlaybackClock {
  t = 0
  playing = false
  speed = 10
  horizon = 2700
  private frameListeners = new Set<Listener>()
  private uiListeners = new Set<Listener>()
  private raf = 0
  private last = 0
  private lastUi = 0
  private frontier: number | null = null

  get buffering(): boolean {
    return this.playing && this.frontier !== null && this.t >= this.frontier && this.t < this.horizon
  }

  setFrontier(t: number | null) {
    this.frontier = t === null ? null : Math.max(0, Math.min(this.horizon, t))
    if (this.frontier !== null && this.t > this.frontier) this.t = this.frontier
    this.emit(true)
  }

  seek(t: number) {
    this.t = Math.max(0, Math.min(this.horizon, this.frontier ?? this.horizon, t))
    this.emit(true)
  }

  setHorizon(h: number) {
    this.horizon = Math.max(1, h)
    if (this.t > this.horizon) this.t = this.horizon
    this.emit(true)
  }

  setSpeed(s: number) {
    this.speed = s
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
    this.t = Math.min(this.horizon, this.frontier ?? this.horizon, this.t + dt * this.speed)
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

export function simClock(t: number): string {
  const total = (SIM_ORIGIN_MIN + Math.floor(t / 60)) % (24 * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
