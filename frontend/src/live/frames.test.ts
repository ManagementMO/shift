import { describe, expect, it, vi } from 'vitest'

import { decodeChunk, LiveReplay } from './frames'

function chunk(times: number[], x = 0): ArrayBuffer {
  const data = new ArrayBuffer(times.length * 72)
  const view = new DataView(data)
  times.forEach((t, i) => {
    const p = i * 72
    for (const [j, c] of [...'CSF1'].entries()) view.setUint8(p + j, c.charCodeAt(0))
    view.setUint32(p + 4, t, true)
    view.setUint32(p + 8, 1, true)
    view.setUint32(p + 12, 1, true)
    view.setUint32(p + 20, 1, true)
    view.setFloat32(p + 44, 20, true)
    view.setUint32(p + 48, 7, true)
    view.setFloat32(p + 52, x + t * 2, true)
    view.setFloat32(p + 56, -40, true)
    view.setFloat32(p + 60, t === 0 ? 350 : 10, true)
    view.setFloat32(p + 64, 2, true)
    view.setUint8(p + 68, 1)
    view.setUint8(p + 69, 1)
    view.setUint16(p + 70, t === 1 ? 0b1001 : 0, true)
  })
  return data
}

describe('Live recorded frames', () => {
  it('decodes world positions and recorded cohort counts without making track copies', () => {
    const data = chunk([0, 1])
    const frames = decodeChunk(data)
    expect(frames.map(f => f.t)).toEqual([0, 1])
    expect(frames[0].counts.walking).toBe(1)
    expect(frames[0].temperature).toBe(20)
    expect(frames[0].view.buffer).toBe(data)
    expect(frames[0].count).toBe(1)
  })

  it('rejects truncated or corrupt payloads', () => {
    expect(() => decodeChunk(chunk([0]).slice(0, -1))).toThrow()
    const bad = chunk([0])
    new DataView(bad).setUint8(0, 0)
    expect(() => decodeChunk(bad)).toThrow()
  })

  it('interpolates only recorded time and turns headings the short way', async () => {
    const replay = new LiveReplay(async () => chunk([0, 1]))
    replay.setFrontier(1)
    await replay.ensure(0.5)
    const seen: number[][] = []
    expect(replay.forEachAt(0.5, (...row) => seen.push(row))).toBe(true)
    expect(seen).toEqual([[7, 1, -40, 0, 2, 1, 1, 0]])
    const later: number[][] = []
    replay.forEachAt(1, (...row) => later.push(row))
    expect(later[0][7]).toBe(0b1001)
    expect(replay.forEachAt(1.5, () => { throw new Error('uncomputed position') })).toBe(false)
    replay.dispose()
  })

  it('deduplicates loads and bounds resident chunks while allowing backward scrubbing', async () => {
    const fetcher = vi.fn(async (start: number) => chunk(Array.from({ length: 10 }, (_, i) => start + i)))
    const replay = new LiveReplay(fetcher, 3)
    replay.setFrontier(99)
    await Promise.all([replay.ensure(0), replay.ensure(0)])
    expect(fetcher).toHaveBeenCalledTimes(1)
    for (const t of [10, 20, 30, 40]) await replay.ensure(t)
    expect(replay.residentChunks).toBeLessThanOrEqual(3)
    await replay.ensure(0)
    const seen: number[][] = []
    replay.forEachAt(0, (...row) => seen.push(row))
    expect(seen[0][1]).toBe(0)
    expect(replay.residentChunks).toBeLessThanOrEqual(3)
    replay.dispose()
  })

  it('refreshes a growing chunk instead of treating its old frontier as complete', async () => {
    let times = [0]
    const replay = new LiveReplay(async () => chunk(times))
    replay.setFrontier(0)
    await replay.ensure(0)
    times = [0, 1, 2]
    replay.setFrontier(2)
    await replay.ensure(1.5)
    const seen: number[][] = []
    replay.forEachAt(1.5, (...row) => seen.push(row))
    expect(seen[0][1]).toBe(3)
    replay.dispose()
  })
})
