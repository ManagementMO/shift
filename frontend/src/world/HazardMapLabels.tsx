import { useEffect, useMemo, useRef, useState } from 'react'
import { canEditScenario, hazardFootprint, scenarioForReplay } from '../replay'
import { HAZARD_KIND_LABEL, useStore } from '../store'
import { mapForSide } from './registry'

/**
 * Removal control for the selected weather event. Clicking the event only selects it;
 * its small cross above the visual performs removal. Escape or an empty-map click dismisses the control.
 */
export default function HazardMapLabels({ runId, side }: { runId: string | null; side: string }) {
  const scenarios = useStore((s) => s.scenarios)
  const scenarioId = useStore((s) => s.scenarioId)
  const replay = useStore((s) => runId ? s.replays[runId] ?? null : null)
  const infoId = useStore((s) => s.hazardInfoId)
  const setHazardInfo = useStore((s) => s.setHazardInfo)
  const deleteHazard = useStore((s) => s.deleteHazard)
  const building = useStore((s) => s.building)
  const scenario = scenarioForReplay(scenarios, scenarioId, replay)
  const editing = canEditScenario(scenario, scenarioId, side)
  const container = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const info = useMemo(() => {
    const hazard = scenario?.hazards.find((h) => h.track_id === infoId)
    const footprint = hazard && hazardFootprint(hazard, 0, true)
    return hazard && footprint ? { hazard, footprint } : null
  }, [scenario, infoId])

  useEffect(() => {
    if (!info) return
    let raf = 0, last = ''
    const update = () => {
      const map = mapForSide(side), box = container.current
      let next: { x: number; y: number } | null = null
      if (map && box) {
        const center = map.project(info.footprint.center)
        const anchor = map.hazardAnchor?.(info.hazard.track_id)
        if (anchor || (center.x >= 0 && center.x <= box.clientWidth && center.y >= 0 && center.y <= box.clientHeight)) {
          const point = anchor ?? { x: center.x, y: Math.min(center.y, ...info.footprint.rings[0].map((p) => map.project(p).y)) }
          if (Number.isFinite(point.x) && Number.isFinite(point.y) && point.x > -100 && point.x < box.clientWidth + 100) {
            next = { x: Math.round(Math.max(24, Math.min(box.clientWidth - 24, point.x))), y: Math.round(Math.max(90, Math.min(box.clientHeight - 24, point.y - 8))) }
          }
        }
      }
      const key = JSON.stringify(next)
      if (last !== key) { last = key; setPos(next) }
      raf = requestAnimationFrame(update)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setHazardInfo(null) }
    window.addEventListener('keydown', onKey)
    update()
    return () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey) }
  }, [info, side, setHazardInfo])

  const label = info ? `Remove ${HAZARD_KIND_LABEL[info.hazard.kind ?? 'storm']}` : ''
  return (
    <div className="hazard-map-labels" ref={container}>
      {info && pos && editing && (
        <button className="hazard-map-remove" style={{ left: pos.x, top: pos.y }} aria-label={label} title={label} disabled={!!building}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); void deleteHazard(info.hazard.track_id) }}>
          ×
        </button>
      )}
    </div>
  )
}
