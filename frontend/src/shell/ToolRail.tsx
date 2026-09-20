import { useEffect } from 'react'
import { useStore, type ToolId } from '../store'
import { AREAS, startPick } from '../world/areaSelect'

const TOOLS: { id: ToolId; label: string; path: string }[] = [
  { id: 'area', label: 'Area select', path: 'M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M12 9v6 M9 12h6' },
  { id: 'closure', label: 'Road closures', path: 'M5 5h14v14H5z M8 12h8' },
  { id: 'development', label: 'Development', path: 'M4 22V9l5-4 5 4v13 M14 22V13l6-3v12 M2 22h20 M7 12h1 M10 12h1 M7 16h1 M10 16h1 M17 15h1 M17 18h1' },
  { id: 'population', label: 'Population', path: 'M8 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M2 20v-3a6 6 0 0 1 12 0v3 M16 5a3 3 0 0 1 0 6 M17 14a5 5 0 0 1 5 5v1' },
  { id: 'temperature', label: 'Temperature', path: 'M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0Z M12 9v7' },
  { id: 'residents', label: 'AI residents', path: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM4 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM20 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM10 8l-4 6m8-6 4 6M7 17h10' },
]

export default function ToolRail({ active = true }: { active?: boolean }) {
  const tool = useStore((s) => s.tool)
  const picking = useStore((s) => s.picking)
  const populationActive = useStore((s) => s.populationActive)
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
        <button key={t.id} className={`railbtn ${isOn(t.id) ? 'on' : ''}`} onClick={() => setTool(tool === t.id ? null : t.id)} disabled={populationActive && t.id !== 'residents' && t.id !== 'area'} title={t.label} aria-label={t.label} aria-pressed={isOn(t.id)}>
          <svg className="glyph" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.path} /></svg>
          <span className="tip">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
