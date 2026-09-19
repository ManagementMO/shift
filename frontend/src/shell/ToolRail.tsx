import { useStore, type ToolId } from '../store'

const TOOLS: { id: ToolId; label: string; glyph: string }[] = [
  { id: 'closure', label: 'Closure', glyph: '⛔' },
  { id: 'route', label: 'Bus route', glyph: '⟿' },
  { id: 'stop', label: 'Bus stop', glyph: '◉' },
  { id: 'population', label: 'Population', glyph: '⁂' },
  { id: 'event', label: 'Event', glyph: '✦' },
  { id: 'weather', label: 'Hazard', glyph: '🌪' },
  { id: 'road', label: 'Road', glyph: '═' },
  { id: 'intersection', label: 'Intersection', glyph: '✚' },
]

export default function ToolRail() {
  const tool = useStore((s) => s.tool)
  const setTool = useStore((s) => s.setTool)
  return (
    <nav className="rail" aria-label="Interventions">
      {TOOLS.map((t) => (
        <button key={t.id} className={`railbtn ${tool === t.id ? 'on' : ''}`} onClick={() => setTool(tool === t.id ? null : t.id)} title={t.label}>
          <span className="glyph">{t.glyph}</span>
          <span className="tip">{t.label}</span>
        </button>
      ))}
    </nav>
  )
}
