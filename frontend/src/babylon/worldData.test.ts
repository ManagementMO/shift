import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

const world = (extra: Record<string, unknown> = {}) => ({ network_fingerprint: 'same', roads: [{ id: 'SUMO-edge', shape: [1, 2, 3, 4] }], buildings: [{ id: 'fallback' }], ...extra })

describe('Prepared Toronto massing', () => {
  it('loads reconciled official geometry from the pack API without changing simulation roads', async () => {
    const asset = { version: 1, prepared: true, network_fingerprint: 'same', buildings: [], excluded_osm_ids: [] }
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(world({ massing_url: '/api/packs/toronto/massing' }))).mockResolvedValueOnce(Response.json(asset))
    vi.stubGlobal('fetch', fetcher)
    const { loadWorld } = await import('./worldData')
    const loaded = await loadWorld('toronto')
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/packs/toronto/massing')
    expect(loaded.massing).toEqual(asset)
    expect(loaded.roads).toEqual([{ id: 'SUMO-edge', shape: [1, 2, 3, 4] }])
  })

  it('never reads the raw public asset directly and ignores unprepared or mismatched geometry', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(world()))
    vi.stubGlobal('fetch', fetcher)
    const { loadWorld } = await import('./worldData')
    expect((await loadWorld('toronto')).massing).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(world({ massing_url: '/api/packs/toronto/massing' }))).mockResolvedValueOnce(Response.json({ version: 1, network_fingerprint: 'same', buildings: [], excluded_osm_ids: [] })))
    expect((await (await import('./worldData')).loadWorld('toronto')).massing).toBeUndefined()
  })

  it.each(['missing', 'offline', 'html'])('keeps the base city usable when the prepared asset is %s', async kind => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(world({ massing_url: '/api/packs/toronto/massing' })))
    if (kind === 'offline') fetcher.mockRejectedValueOnce(new Error('offline'))
    else fetcher.mockResolvedValueOnce(kind === 'missing' ? new Response(null, { status: 404 }) : new Response('<html>SPA fallback</html>', { headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetcher)
    const { loadWorld } = await import('./worldData')
    const loaded = await loadWorld('toronto')
    expect(loaded.massing).toBeUndefined()
    expect(loaded.buildings).toEqual([{ id: 'fallback' }])
  })
})
