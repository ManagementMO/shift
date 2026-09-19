import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

describe('Optional Toronto massing', () => {
  it('uses matching official geometry without changing simulation roads', async () => {
    const roads = [{ id: 'SUMO-edge', shape: [1,2,3,4] }]
    const asset = { version: 1, network_fingerprint: 'same', buildings: [], excluded_osm_ids: [] }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({network_fingerprint:'same',roads})).mockResolvedValueOnce(Response.json(asset)))
    const { loadWorld } = await import('./worldData')
    const world = await loadWorld('toronto')
    expect(world.massing).toEqual(asset)
    expect(world.roads).toEqual(roads)
  })

  it('refuses geometry aligned to a different city network', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({network_fingerprint:'new-network'})).mockResolvedValueOnce(Response.json({version:1,network_fingerprint:'old-network'})))
    const { loadWorld } = await import('./worldData')
    expect((await loadWorld('toronto')).massing).toBeUndefined()
  })

  it.each(['missing', 'offline', 'html'])('keeps the base city usable when the optional asset is %s', async kind => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({network_fingerprint:'same',buildings:[{id:'fallback'}]}))
    if (kind === 'offline') fetcher.mockRejectedValueOnce(new Error('offline'))
    else fetcher.mockResolvedValueOnce(kind === 'missing' ? new Response(null,{status:404}) : new Response('<html>SPA fallback</html>',{headers:{'content-type':'text/html'}}))
    vi.stubGlobal('fetch', fetcher)
    const { loadWorld } = await import('./worldData')
    const world = await loadWorld('toronto')
    expect(world.massing).toBeUndefined()
    expect(world.buildings).toEqual([{id:'fallback'}])
  })
})
