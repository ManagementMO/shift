// Between-sample interpolation for the Babylon replay.  SUMO samples every second; a vehicle drawn at a
// 60 Hz frame is placed on the straight segment between the two neighbouring recorded samples.  Nothing is
// ever interpolated across a recorded break (teleport) or a gap wider than MAX_GAP_S — the entity simply
// holds its last measured sample, then disappears.

import { MAX_GAP_S, type TrackIndex } from '../replay'

export interface Interp {
  lon: number
  lat: number
  /** SUMO heading, degrees clockwise from north. */
  angle: number
  speed: number
  /** Index of the sample at/before t (the "from" sample). */
  i: number
  /** 0..1 blend towards sample i+1 (0 when holding). */
  k: number
}

function lowerBound(arr: number[], t: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

export function lerpAngle(a: number, b: number, k: number): number {
  let d = ((b - a + 540) % 360) - 180
  if (d < -180) d += 360
  return (a + d * k + 360) % 360
}

export function interpAt(ix: TrackIndex, t: number, out: Interp): Interp | null {
  const i = lowerBound(ix.times, t)
  if (i < 0) return null
  const s = ix.track.samples[i]
  if (t - s[0] > MAX_GAP_S) return null
  out.i = i
  const n = ix.track.samples[i + 1]
  // i+1 in breakSet means the trail must break *before* sample i+1: no blend from i to i+1.
  if (n && !ix.breakSet.has(i + 1) && n[0] - s[0] <= MAX_GAP_S && n[0] > s[0]) {
    const k = (t - s[0]) / (n[0] - s[0])
    out.k = k
    out.lon = s[1] + (n[1] - s[1]) * k
    out.lat = s[2] + (n[2] - s[2]) * k
    out.angle = lerpAngle(s[3], n[3], k)
    out.speed = s[4] + (n[4] - s[4]) * k
  } else {
    out.k = 0
    out.lon = s[1]
    out.lat = s[2]
    out.angle = s[3]
    out.speed = s[4]
  }
  return out
}
