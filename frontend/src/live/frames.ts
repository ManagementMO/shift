export const CHUNK_SECONDS = 10
const HEADER_BYTES = 48
const ROW_BYTES = 24
const COUNT_KEYS = ['total', 'not_departed', 'walking', 'waiting', 'riding', 'driving', 'arrived', 'unroutable'] as const
export type LiveCounts = Record<(typeof COUNT_KEYS)[number], number>
export type FrameVisitor = (index: number, x: number, z: number, heading: number, speed: number, kind: number, state: number, flags: number) => void

export interface RecordedFrame {
  t: number
  count: number
  counts: LiveCounts
  temperature: number
  view: DataView
}

export function decodeChunk(buffer: ArrayBuffer): RecordedFrame[] {
  const data = new DataView(buffer)
  const frames: RecordedFrame[] = []
  let offset = 0
  let previous = -1
  while (offset < buffer.byteLength) {
    if (offset + HEADER_BYTES > buffer.byteLength || data.getUint32(offset, true) !== 0x31465343) throw new Error('Invalid recorded frame header')
    const t = data.getUint32(offset + 4, true)
    const count = data.getUint32(offset + 8, true)
    const end = offset + HEADER_BYTES + count * ROW_BYTES
    if (count > 10032 || end > buffer.byteLength || (previous >= 0 && t !== previous + 1)) throw new Error('Incomplete or unordered recorded frames')
    const counts = Object.fromEntries(COUNT_KEYS.map((key, i) => [key, data.getUint32(offset + 12 + i * 4, true)])) as LiveCounts
    const temperature = data.getFloat32(offset + 44, true)
    if (counts.total > 10000 || COUNT_KEYS.slice(1).reduce((sum, key) => sum + counts[key], 0) !== counts.total || !Number.isFinite(temperature)) throw new Error('Invalid recorded cohort')
    const view = new DataView(buffer, offset + HEADER_BYTES, count * ROW_BYTES)
    let previousId = -1
    for (let i = 0; i < count; i++) {
      const p = i * ROW_BYTES
      const id = view.getUint32(p, true)
      if (id <= previousId || ![4, 8, 12, 16].every(k => Number.isFinite(view.getFloat32(p + k, true)))) throw new Error('Invalid recorded position')
      if (view.getUint8(p + 20) < 1 || view.getUint8(p + 20) > 3 || view.getUint8(p + 21) > 6) throw new Error('Invalid recorded entity')
      previousId = id
    }
    frames.push({ t, count, counts, temperature, view })
    previous = t
    offset = end
  }
  return frames
}

type CachedChunk = { frames: Map<number, RecordedFrame>; bytes: number }
type FetchChunk = (start: number, signal: AbortSignal) => Promise<ArrayBuffer>

export class LiveReplay {
  private readonly fetchChunk: FetchChunk
  private readonly maxChunks: number
  private readonly chunks = new Map<number, CachedChunk>()
  private readonly pending = new Map<number, Promise<void>>()
  private readonly abort = new AbortController()
  private frontier = -1
  private disposed = false

  constructor(fetchChunk: FetchChunk, maxChunks = 6) {
    this.fetchChunk = fetchChunk
    this.maxChunks = Math.max(2, maxChunks)
  }

  setFrontier(t: number): void {
    if (!Number.isInteger(t) || t < 0) throw new Error('Invalid recorded frontier')
    this.frontier = Math.max(this.frontier, t)
  }

  get residentChunks(): number { return this.chunks.size }
  get residentBytes(): number { return [...this.chunks.values()].reduce((sum, c) => sum + c.bytes, 0) }

  frameAt(t: number): RecordedFrame | null {
    if (t < 0 || t > this.frontier || !Number.isFinite(t)) return null
    const second = Math.floor(t)
    return this.chunks.get(second - second % CHUNK_SECONDS)?.frames.get(second) ?? null
  }

  async ensure(t: number): Promise<void> {
    if (this.disposed) return
    if (!Number.isFinite(t) || t < 0 || t > this.frontier) throw new Error('Time has not been simulated')
    const a = Math.floor(t)
    const b = Math.min(a + 1, this.frontier)
    const starts = new Map<number, number>()
    for (const time of [a, b]) starts.set(time - time % CHUNK_SECONDS, time)
    await Promise.all([...starts].map(([start, required]) => this.load(start, required)))
  }

  private load(start: number, required: number): Promise<void> {
    const cached = this.chunks.get(start)
    if (cached?.frames.has(required)) {
      this.chunks.delete(start)
      this.chunks.set(start, cached)
      return Promise.resolve()
    }
    const pending = this.pending.get(start)
    if (pending) return pending
    const promise = this.fetchChunk(start, this.abort.signal).then(buffer => {
      if (this.disposed) return
      const frames = decodeChunk(buffer)
      if (!frames.length || frames.some(f => f.t < start || f.t >= start + CHUNK_SECONDS)) throw new Error('Incorrect recorded chunk range')
      this.chunks.delete(start)
      this.chunks.set(start, { frames: new Map(frames.map(f => [f.t, f])), bytes: buffer.byteLength })
      while (this.chunks.size > this.maxChunks) this.chunks.delete(this.chunks.keys().next().value!)
    }).finally(() => this.pending.delete(start))
    this.pending.set(start, promise)
    return promise
  }

  forEachAt(t: number, visit: FrameVisitor): boolean {
    const a = this.frameAt(t)
    if (!a) return false
    const k = t - a.t
    const b = this.frameAt(a.t + 1)
    if (k > 0 && !b) return false
    let j = 0
    for (let i = 0; i < a.count; i++) {
      const p = i * ROW_BYTES
      const id = a.view.getUint32(p, true)
      const kind = a.view.getUint8(p + 20)
      while (b && j < b.count && b.view.getUint32(j * ROW_BYTES, true) < id) j++
      const q = j * ROW_BYTES
      const blend = b && j < b.count && b.view.getUint32(q, true) === id && b.view.getUint8(q + 20) === kind ? k : 0
      const value = (field: number): number => {
        const v = a.view.getFloat32(p + field, true)
        return blend && b ? v + (b.view.getFloat32(q + field, true) - v) * blend : v
      }
      const heading = a.view.getFloat32(p + 12, true)
      const angle = blend && b ? (heading + (((b.view.getFloat32(q + 12, true) - heading + 540) % 360) - 180) * blend + 360) % 360 : heading
      visit(id, value(4), value(8), angle, value(16), kind, a.view.getUint8(p + 21), a.view.getUint16(p + 22, true))
    }
    return true
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    this.chunks.clear()
    this.pending.clear()
  }
}
