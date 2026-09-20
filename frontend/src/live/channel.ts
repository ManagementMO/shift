import type { LiveTrafficSource } from '../babylon/traffic'
import { liveApi } from './api'
import { LiveReplay } from './frames'
import type { LiveMetadata, LiveSession } from './types'

export class LiveChannel implements LiveTrafficSource {
  state: LiveSession
  metadata: LiveMetadata = { entities: [], routes: [], fleet: [] }
  readonly replay: LiveReplay
  private byIndex = new Map<number, LiveMetadata['entities'][number]>()
  private metadataRevision = -1
  private refreshVersion = 0
  private disposed = false
  private readonly abort = new AbortController()

  constructor(state: LiveSession) {
    this.state = state
    this.replay = new LiveReplay((start, signal) => liveApi.chunk(state.session_id, start, signal))
    if (state.available_until_s >= 0) this.replay.setFrontier(state.available_until_s)
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    const version = ++this.refreshVersion
    try {
      const state = await liveApi.state(this.state.session_id, this.abort.signal)
      if (this.disposed || version !== this.refreshVersion) return
      if (state.status === 'failed') throw new Error(state.error ?? 'SUMO stopped unexpectedly')
      if (state.status !== 'starting' && state.status !== 'restoring' && (this.metadataRevision !== state.revision || this.metadata.entities.length !== state.entity_count)) {
        const metadata = await liveApi.metadata(state.session_id, this.abort.signal)
        if (this.disposed || version !== this.refreshVersion) return
        this.metadata = metadata
        this.byIndex = new Map(metadata.entities.map(e => [e.index, e]))
        this.metadataRevision = state.revision
      }
      this.state = state
      if (state.available_until_s >= 0) this.replay.setFrontier(state.available_until_s)
    } catch (error) {
      if (!this.disposed && version === this.refreshVersion) throw error
    }
  }

  entity(index: number) { return this.byIndex.get(index) }
  releasedAt(t: number): number {
    const counts = this.replay.frameAt(t)?.counts
    return counts ? counts.total - counts.not_departed - counts.unroutable : 0
  }
  forEachAt: LiveTrafficSource['forEachAt'] = (t, visit) => this.replay.forEachAt(t, visit)

  dispose(): void {
    this.disposed = true
    this.refreshVersion++
    this.abort.abort()
    this.replay.dispose()
    this.byIndex.clear()
  }
}
