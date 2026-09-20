import type { FormEvent, KeyboardEvent } from 'react'
import type { GodHUDProps, GodTab, GodTool } from './model'
import { GodIcon } from './icons'
import { GlassButton, GlassIconButton, GlassSurface } from './ui'
import './chrome.css'

const tabs: { value: GodTab; label: string }[] = [
  { value: 'live', label: 'Live' },
  { value: 'simulate', label: 'Simulate' },
  { value: 'agents', label: 'Agents' },
  { value: 'events', label: 'Events' },
  { value: 'analytics', label: 'Analytics' },
]

const tools: { value: GodTool; icon: string; label: string }[] = [
  { value: 'select', icon: 'cursor', label: 'Select objects' },
  { value: 'map', icon: 'map', label: 'Map' },
  { value: 'people', icon: 'people', label: 'People and agent groups' },
  { value: 'transport', icon: 'bus', label: 'Transit' },
  { value: 'events', icon: 'warning', label: 'Events' },
  { value: 'weather', icon: 'cloud', label: 'Weather' },
  { value: 'layers', icon: 'layers', label: 'Map layers' },
]

export default function GodChrome({ activeTab, openTab = null, activeTool, timeLabel, weatherLabel, temperatureLabel, weatherNote, command, commandBusy = false, onTab, onTool, onHome, onCommandChange, onCommand }: GodHUDProps) {
  const selectedTab = openTab ?? activeTab

  function submitCommand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!commandBusy && command.trim()) onCommand()
  }

  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    const current = tabs.findIndex((tab) => tab.value === selectedTab)
    let next: number
    switch (event.key) {
      case 'ArrowRight': next = (current + 1) % tabs.length; break
      case 'ArrowLeft': next = (current - 1 + tabs.length) % tabs.length; break
      case 'Home': next = 0; break
      case 'End': next = tabs.length - 1; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    onTab(tabs[next].value)
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div className="god-chrome" data-active-tab={activeTab} data-open-tab={openTab ?? undefined} data-active-tool={activeTool} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <GlassButton variant="ghost" className="god-chrome__brand" onClick={onHome} aria-label="God’s Plan home" title="Return to the globe">
        <GodIcon name="globe" size={28} strokeWidth={1.35} className="god-chrome__globe" />
        <span className="god-chrome__wordmark">God’s Plan</span>
      </GlassButton>

      <GlassSurface tone="light" className="god-chrome__tabs" role="tablist" aria-label="City views" onKeyDown={navigateTabs}>
        {tabs.map((tab) => (
          <GlassButton key={tab.value} variant={activeTab === tab.value ? 'primary' : 'ghost'} className="god-chrome__tab" role="tab" aria-selected={selectedTab === tab.value} tabIndex={selectedTab === tab.value ? 0 : -1} data-active={activeTab === tab.value} data-open={openTab === tab.value} onClick={() => onTab(tab.value)}>{tab.label}</GlassButton>
        ))}
      </GlassSurface>

      <GlassSurface tone="dark" className="god-chrome__weather" role="group" aria-label="Simulation time and weather" title={weatherNote}>
        <span className="god-chrome__time">{timeLabel}</span>
        <GodIcon name={weatherLabel === 'Clear' ? 'sun' : 'cloud'} size={20} className="god-chrome__sun" />
        <span className="god-chrome__weather-label">{weatherLabel}</span>
        <span className="god-chrome__temperature">{temperatureLabel}</span>
      </GlassSurface>

      <GlassSurface tone="dark" className="god-chrome__tools" role="group" aria-label="City tools">
        {tools.map((tool) => <GlassIconButton key={tool.value} icon={tool.icon} label={tool.label} size={21} className="god-chrome__tool" data-tool={tool.value} aria-pressed={activeTool === tool.value} onClick={() => onTool(tool.value)} />)}
      </GlassSurface>

      <div className="god-chrome__command-zone">
        <form className="god-chrome__command-form" onSubmit={submitCommand} aria-label="City command" aria-busy={commandBusy}>
          <GlassSurface tone="dark" className="god-chrome__command-dock">
            <GodIcon name="sparkles" size={20} className="god-chrome__sparkles" />
            <input className="god-chrome__command-input" type="text" aria-label="Tell the city what happens" placeholder="Tell the city what happens…" value={command} onChange={(event) => onCommandChange(event.target.value)} readOnly={commandBusy} autoComplete="off" spellCheck={false} />
            <GlassIconButton icon="arrow-right" label={commandBusy ? 'Sending command' : 'Send command'} size={19} className="god-chrome__submit" type="submit" disabled={commandBusy || !command.trim()} />
          </GlassSurface>
        </form>
      </div>
    </div>
  )
}
