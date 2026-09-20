import { PlaybackClock } from '../world/playback'
import { liveApi } from './api'
import { LiveChannel } from './channel'
import type { Intervention, LiveCommand, LiveConfig, LivePreview, LiveSession } from './types'

export interface LiveViewState {
  primary: LiveChannel | null
  baseline: LiveChannel | null
  t: number
  playing: boolean
  followLive: boolean
  busy: string | null
  error: string | null
  draft: LivePreview | null
  loading: boolean
  buffering: boolean
}

const ready = (channel: LiveChannel) => !['starting', 'restoring', 'failed'].includes(channel.state.status)

export class LiveController {
  readonly clock = new PlaybackClock()
  private primary: LiveChannel | null = null
  private baseline: LiveChannel | null = null
  private listeners = new Set<() => void>()
  private busy: string | null = null
  private error: string | null = null
  private draft: LivePreview | null = null
  private command: LiveCommand | null = null
  private loading = false
  private followLive = true
  private autoPlay = false
  private stopped = false
  private polling = false
  private timer: ReturnType<typeof setInterval> | null = null
  private epoch = 0
  private seekVersion = 0
  private view: LiveViewState = { primary: null, baseline: null, t: 0, playing: false, followLive: true, busy: null, error: null, draft: null, loading: false, buffering: false }

  constructor() { this.clock.onUi(() => this.emit()) }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.view

  start(): void {
    this.stopped = false
    if (!this.timer) this.timer = setInterval(() => { void this.pump() }, 200)
  }

  private emit(): void {
    this.view = { primary: this.primary, baseline: this.baseline, t: this.clock.t, playing: this.clock.playing, followLive: this.followLive, busy: this.busy, error: this.error, draft: this.draft, loading: this.loading, buffering: this.clock.buffering }
    for (const listener of this.listeners) listener()
  }

  private async action(label: string, work: () => Promise<void>): Promise<void> {
    if (this.busy) return
    this.busy = label
    this.error = null
    this.emit()
    try { await work() }
    catch (error) { if (!this.stopped) this.error = error instanceof Error ? error.message : String(error) }
    finally { this.busy = null; this.emit() }
  }

  private async install(state: LiveSession, at?: number): Promise<void> {
    const epoch = ++this.epoch
    this.clock.pause()
    this.primary?.dispose()
    this.baseline?.dispose()
    this.baseline = null
    const channel = new LiveChannel(state)
    this.primary = channel
    this.clock.setHorizon(state.horizon_s)
    this.clock.setFrontier(Math.max(0, state.available_until_s))
    this.clock.seek(at ?? Math.max(0, state.available_until_s))
    this.followLive = at === undefined || at >= state.available_until_s
    this.draft = null
    this.command = null
    this.emit()
    await channel.refresh()
    if (epoch !== this.epoch || this.stopped) return
    if (ready(channel) && channel.state.available_until_s >= 0) await channel.replay.ensure(this.clock.t)
    this.emit()
  }

  async open(id: string, at?: number): Promise<void> {
    await this.action('Loading recorded city', async () => {
      this.autoPlay = false
      await this.install(await liveApi.state(id), at)
    })
  }

  async create(config: Partial<LiveConfig> & { pack_id: string }): Promise<void> {
    await this.action('Starting SUMO', async () => {
      if (this.primary) await liveApi.pause(this.primary.state.session_id)
      await this.install(await liveApi.create(config), 0)
      this.autoPlay = true
      this.followLive = true
    })
  }

  private channels(): LiveChannel[] { return [this.primary, this.baseline].filter((c): c is LiveChannel => c !== null) }
  recordedUntil(): number { return this.primary ? Math.max(0, Math.min(...this.channels().map(c => c.state.available_until_s), this.clock.horizon)) : 0 }

  private async pauseNow(snap: boolean): Promise<void> {
    const atEdge = snap && this.followLive && this.clock.playing
    this.autoPlay = false
    this.clock.pause()
    await Promise.all(this.channels().filter(ready).map(c => liveApi.pause(c.state.session_id)))
    await Promise.all(this.channels().map(c => c.refresh()))
    this.clock.setFrontier(this.recordedUntil())
    if (atEdge) this.clock.seek(this.recordedUntil())
    await Promise.all(this.channels().filter(ready).map(c => c.replay.ensure(this.clock.t)))
  }

  async pause(snap = true): Promise<void> { await this.action('Pausing at a simulation step', () => this.pauseNow(snap)) }

  beginScrub(): void {
    this.autoPlay = false
    this.followLive = false
    this.clock.pause()
    this.discard()
    for (const channel of this.channels().filter(ready)) void liveApi.pause(channel.state.session_id).catch(error => {
      if (!this.stopped) { this.error = error instanceof Error ? error.message : String(error); this.emit() }
    })
  }

  async seek(t: number): Promise<void> {
    if (!this.primary || this.busy || !Number.isFinite(t)) return
    this.draft = null
    this.command = null
    const version = ++this.seekVersion
    this.clock.pause()
    this.autoPlay = false
    this.followLive = false
    this.clock.setFrontier(this.recordedUntil())
    this.clock.seek(Math.floor(t))
    this.loading = true
    this.emit()
    try { await Promise.all(this.channels().map(c => c.replay.ensure(this.clock.t))) }
    catch (error) { if (version === this.seekVersion) this.error = error instanceof Error ? error.message : String(error) }
    finally { if (version === this.seekVersion) { this.loading = false; this.emit() } }
  }

  async play(): Promise<void> {
    if (!this.primary || this.busy) return
    this.discard()
    await this.action('Preparing playback', async () => {
      if (this.clock.t >= this.primary!.state.available_until_s && this.primary!.state.status === 'closed') {
        await this.install(await liveApi.resume(this.primary!.state.session_id), this.clock.t)
      }
      if (this.clock.t >= this.clock.horizon) { this.clock.seek(0); this.followLive = false }
      await Promise.all(this.channels().filter(ready).map(c => c.replay.ensure(this.clock.t)))
      this.autoPlay = !this.channels().every(ready)
      if (!this.autoPlay) this.clock.play()
    })
  }

  toggle(): void { if (this.clock.playing) void this.pause(); else void this.play() }
  setSpeed(speed: number): void { this.clock.setSpeed(Math.max(1, Math.min(20, speed))); this.emit() }
  async liveEdge(): Promise<void> { await this.seek(this.recordedUntil()); this.followLive = true; await this.play() }

  async preview(intervention: Intervention): Promise<void> {
    if (!this.primary) return
    await this.action('Validating intervention', async () => {
      await this.pauseNow(true)
      const channel = this.primary!
      this.clock.seek(Math.floor(this.clock.t))
      const command: LiveCommand = { command_id: `cmd-${crypto.randomUUID()}`, at_s: this.clock.t, expected_revision: channel.state.revision, intervention }
      this.draft = await liveApi.preview(channel.state.session_id, command)
      this.command = command
    })
  }

  discard(): void { this.draft = null; this.command = null; this.error = null; this.emit() }

  async apply(): Promise<void> {
    if (!this.primary || !this.command) return
    await this.action('Applying changes in SUMO', async () => {
      this.clock.pause()
      const command = this.command!
      const state = await liveApi.apply(this.primary!.state.session_id, command)
      await this.install(state, command.at_s)
      this.followLive = true
      this.autoPlay = true
    })
  }

  async compare(enabled: boolean): Promise<void> {
    if (!enabled) { this.baseline?.dispose(); this.baseline = null; this.emit(); return }
    const parent = this.primary?.state.parent_session_id
    if (!parent) return
    await this.action('Loading original timeline', async () => {
      await this.pauseNow(false)
      this.baseline?.dispose()
      this.baseline = new LiveChannel(await liveApi.state(parent))
      await this.baseline.refresh()
      this.clock.setFrontier(this.recordedUntil())
      await Promise.all(this.channels().map(c => c.replay.ensure(this.clock.t)))
    })
  }

  private async pump(): Promise<void> {
    if (this.polling || this.busy || this.stopped || !this.primary || this.loading) return
    this.polling = true
    const primary = this.primary
    try {
      const channels = this.channels()
      await Promise.all(channels.map(c => c.refresh()))
      if (this.stopped || this.primary !== primary) return
      if (!channels.every(ready)) { this.emit(); return }
      const end = this.recordedUntil()
      const t = Math.min(this.clock.t, end)
      const wanted = Math.min(end, Math.ceil(t + Math.min(8, Math.max(2, this.clock.speed * 0.6))))
      await Promise.all(channels.flatMap(c => [c.replay.ensure(t), c.replay.ensure(wanted)]))
      if (this.stopped || this.primary !== primary) return
      let buffered = Math.floor(t)
      for (let i = buffered; i <= wanted; i++) {
        if (!channels.every(c => c.replay.frameAt(i))) break
        buffered = i
      }
      this.clock.setFrontier(buffered)
      if (this.autoPlay) { this.autoPlay = false; this.clock.play() }
      if (this.clock.playing) {
        for (const channel of channels) {
          const state = channel.state
          const target = Math.min(state.horizon_s, Math.ceil(this.clock.t + Math.max(3, this.clock.speed)))
          if (state.status === 'paused' && target > state.time_s) await liveApi.advance(state.session_id, target)
          if (state.status === 'closed' && this.clock.t >= state.available_until_s - 1 && state.available_until_s < state.horizon_s) {
            const resumed = new LiveChannel(await liveApi.resume(state.session_id))
            if (channel === this.primary) this.primary = resumed
            else this.baseline = resumed
            channel.dispose()
          }
        }
      }
      this.emit()
    } catch (error) {
      if (!this.stopped && this.primary === primary) {
        this.error = error instanceof Error ? error.message : String(error)
        this.clock.pause()
        this.emit()
      }
    } finally { this.polling = false }
  }

  stop(): void {
    this.stopped = true
    this.epoch++
    this.seekVersion++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.clock.pause()
    for (const channel of this.channels()) {
      void liveApi.pause(channel.state.session_id).catch(() => {})
      channel.dispose()
    }
    this.primary = null
    this.baseline = null
  }
}
