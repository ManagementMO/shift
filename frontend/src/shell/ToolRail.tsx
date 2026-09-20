import { useEffect } from 'react'
import { useStore, type ToolId } from '../store'
import { AREAS, startPick } from '../world/areaSelect'

const TOOLS: { id: ToolId; label: string; path: string }[] = [
  { id: 'area', label: 'Area select', path: 'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M12 9v6 M9 12h6' },
  { id: 'closure', label: 'Closure', path: 'M5 5h14v14H5z M8 12h8' },
  { id: 'route', label: 'Bus route', path: 'M5 18v-7a5 5 0 0 1 5-5h8 M14 2l4 4-4 4 M3 18h4v4H3z' },
  { id: 'stop', label: 'Bus stop', path: 'M6 4h12v12H6z M9 8h6 M12 16v6 M8 22h8' },
  { id: 'population', label: 'Population', path: 'M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M2 20v-3a6 6 0 0 1 12 0v3 M16 5a3 3 0 0 1 0 6 M17 14a5 5 0 0 1 5 5v1' },
  { id: 'event', label: 'Event', path: 'M5 5h14v16H5z M8 2v6 M16 2v6 M5 11h14 M9 15h6' },
  { id: 'weather', label: 'Tornado', path: 'M3 5h18 M5 9h13 M8 13h9 M10 17h5 M12 21h2' },
  { id: 'road', label: 'Road', path: 'M7 2L4 22 M17 2l3 20 M12 3v4 M12 10v4 M12 17v4' },
  { id: 'intersection', label: 'Intersection', path: 'M8 2v6H2 M16 2v6h6 M2 16h6v6 M22 16h-6v6' },
]

export default function ToolRail({ active = true }: { active?: boolean }) {
  const tool = useStore((s) => s.tool)
  const picking = useStore((s) => s.picking)
  const setTool = useStore((s) => s.setTool)
  // Area select stays lit while a pick runs with its panel closed
  const isOn = (id: ToolId) => tool === id || (id === 'area' && picking)

  // Area select shortcuts: 2 / 3 open the panel and start the pick straight away.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || target?.isContentEditable || target?.closest('input, textarea, select, button')) return
      const area = AREAS.find((a) => a.key === e.key)
      if (!area) return
      useStore.getState().setTool('area')
      startPick(area.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  return (
    <nav className="rail" aria-label="Interventions">
      {TOOLS.map((t) => (
        <button key={t.id} className={`railbtn ${isOn(t.id) ? 'on' : ''}`} onClick={() => setTool(tool === t.id ? null : t.id)} title={t.label} aria-label={t.label} aria-pressed={isOn(t.id)}>
          <svg className="glyph" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.path} /></svg>
          <span className="tip">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
