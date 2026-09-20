export function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function timelineTicks(horizon: number): number[] {
  const step = horizon > 3600 * 2 ? 1800 : horizon > 3600 ? 900 : 600
  const ticks: number[] = []
  for (let t = 0; t <= horizon; t += step) ticks.push(t)
  if (ticks[ticks.length - 1] !== horizon) ticks.push(horizon)
  return ticks
}

export function bubblePlacement(point: { x: number; y: number }, box: { width: number; height: number }, viewport: { width: number; height: number }) {
  const margin = 12
  const minTop = 76
  const maxTop = Math.max(minTop, viewport.height - box.height - 140)
  const above = point.y - box.height - 26
  const fitsAbove = above >= minTop && above <= maxTop
  const beside = point.x - box.width - 30 >= margin
    ? point.x - box.width / 2 - 30
    : point.x + box.width / 2 + 30
  const preferredX = fitsAbove ? point.x : beside
  const left = Math.max(box.width / 2 + margin, Math.min(viewport.width - box.width / 2 - margin, preferredX))
  const top = Math.max(minTop, Math.min(maxTop, fitsAbove ? above : point.y - box.height / 2))
  return { left, top, shifted: !fitsAbove || left !== point.x }
}
