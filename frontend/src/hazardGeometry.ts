export type HazardPoint = [number, number]
export const MAX_FIRE_POINTS = 64

export function distanceToStroke(point: HazardPoint, path: HazardPoint[]): number {
  if (!path.length) return Infinity
  let distance = Math.hypot(point[0] - path[0][0], point[1] - path[0][1])
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const length2 = dx * dx + dy * dy
    const t = length2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2)) : 0
    distance = Math.min(distance, Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy))
  }
  return distance
}

export function strokeSamples(path: HazardPoint[], spacing: number, limit = 96): HazardPoint[] {
  if (path.length < 2) return path.slice()
  const lengths = path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1]))
  const total = lengths.reduce((a, b) => a + b, 0)
  const step = Math.max(spacing, total / Math.max(1, limit - 1), 0.1)
  const points = [path[0]]
  let travelled = 0, next = step
  lengths.forEach((length, i) => {
    while (length > 0 && next < travelled + length && points.length < limit - 1) {
      const t = (next - travelled) / length
      points.push([path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t])
      next += step
    }
    travelled += length
  })
  points.push(path[path.length - 1])
  return points
}
