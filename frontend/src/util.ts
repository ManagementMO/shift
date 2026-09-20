export function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** Every vertex of the named SUMO edges, in lon/lat, from the pack's roads GeoJSON. */
export function edgePath(roads: GeoJSON.FeatureCollection | null, edgeIds: Iterable<string>): [number, number][] {
  if (!roads) return []
  const want = new Set(edgeIds)
  const pts: [number, number][] = []
  for (const f of roads.features) {
    if (!want.has(String(f.properties?.id)) || f.geometry.type !== 'LineString') continue
    for (const c of f.geometry.coordinates) pts.push([c[0], c[1]])
  }
  return pts
}

/** Mean of a set of lon/lat points, or null when there are none. */
export function centroidOf(pts: [number, number][]): [number, number] | null {
  if (!pts.length) return null
  let lon = 0
  let lat = 0
  for (const p of pts) {
    lon += p[0]
    lat += p[1]
  }
  return [lon / pts.length, lat / pts.length]
}
