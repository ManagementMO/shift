import type { ReactNode } from 'react'

export type GodTab = 'live' | 'log' | 'agents' | 'events' | 'analytics'
export type GodTool = 'select' | 'map' | 'people' | 'population' | 'events' | 'weather' | 'layers'
export type GodEventKind = 'normal' | 'closure' | 'development' | 'tornado' | 'rain' | 'storm' | 'earthquake' | 'flood' | 'wildfire' | 'outage' | 'riot' | 'transit' | 'orbital' | 'custom'
export type GodEventCategory = 'all' | 'natural' | 'infrastructure' | 'social' | 'custom'
export type GodIntensity = 'low' | 'medium' | 'high'

export interface GodEventDraft {
  kind: GodEventKind
  intensity: GodIntensity
  radiusM: number
  durationS: number
  autoRespond: boolean
  heading: number
}

export interface GodEventStatus {
  id: string
  kind: GodEventKind
  label: string
  area: string
  start: number
  end: number
  radiusM: number
  intensity: GodIntensity
  affectedBuildings: number
  failedBuildings: number
  affectedAgents: number | null
  visualOnly: boolean
}

export interface GodCitizen {
  id: string
  name: string
  avatarUrl?: string
  age?: number
  occupation?: string
  neighborhood?: string
  role: string
  status: string
  destination: string
  activity: string
  synthetic: boolean
  traits: string[]
  thoughts: string[]
  quote?: string
  mood?: string
  thoughtTimes?: string[]
  relationships: { id: string; name: string; role: string; avatarUrl?: string; strength?: number; sentiment?: string }[]
  isPreview?: boolean
}

export interface GodAgentMember {
  id: string
  name: string
  role: string
  status: string
  avatarUrl?: string
  active: boolean
}

export interface GodHUDProps {
  city: string
  activeTab: GodTab
  openTab?: GodTab | null
  rightPanelOpen?: boolean
  activeTool: GodTool
  dateLabel: string
  timeLabel: string
  weatherLabel: string
  temperatureLabel: string
  weatherNote?: string
  statusLabel: string
  agentCount: number
  playing: boolean
  /** Playback speed multiplier and the choices offered in the dock. */
  speed?: number
  speeds?: readonly number[]
  /** False while SUMO is starting or busy: the dock's controls are disabled. */
  ready?: boolean
  is2D: boolean
  command: string
  commandBusy?: boolean
  /** Recorded playback sits below the prompt in the shared bottom-centre stack. */
  recordingControls?: ReactNode
  suggestions?: readonly string[]
  onTab: (tab: GodTab) => void
  onTool: (tool: GodTool) => void
  onHome: () => void
  onCommandChange: (value: string) => void
  onCommand: () => void
  onSuggestion: (value: string) => void
  onTogglePlay: () => void
  onSpeed?: (speed: number) => void
  onView: (action: 'locate' | 'projection' | 'settings' | 'zoom-in' | 'zoom-out') => void
}
