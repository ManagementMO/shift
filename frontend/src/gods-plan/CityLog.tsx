import { useMemo } from 'react'
import { developmentCounts, developmentLabel } from '../development'
import { HAZARDS, type Intervention, type LiveSession } from '../live/types'
import type { VisualCityEvent } from './state'
import { simClock } from '../world/playback'
import type { CityPack, Corridor } from '../types'
import { GlassIconButton, GlassSurface } from './ui'
import { GodIcon } from './icons'

export type LogSource = 'Roads' | 'Transit' | 'Planning' | 'People' | 'Weather' | 'Emergency' | 'City Hall'

export interface LogEntry {
  id: string
  /** simulated seconds; entries are shown newest first */
  at: number
  source: LogSource
  title: string
  body: string
  /** a visual-only event (not measured by SUMO) */
  visual?: boolean
}

const ICONS: Record<LogSource, string> = { Roads: 'route', Transit: 'bus', Planning: 'building', People: 'users', Weather: 'cloud', Emergency: 'warning', 'City Hall': 'globe' }

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

function streetName(edges: string[], corridors: Record<string, Corridor>): string | null {
  return Object.values(corridors).find((c) => c.edge_ids.every((e) => edges.includes(e)))?.label ?? Object.values(corridors).find((c) => c.edge_ids.some((e) => edges.includes(e)))?.label ?? null
}

function weatherNote(temperature: number): string {
  if (temperature <= -20) return 'Extreme cold. Walkers slow right down and give up on long walks; expect more people waiting for transport.'
  if (temperature <= 0) return 'Freezing. People walk more slowly and shorten their walks.'
  if (temperature < 10) return 'Cold. Slightly slower walking and shorter walking tolerance.'
  if (temperature >= 35) return 'Extreme heat. Walkers tire sooner and cut long walks short.'
  if (temperature >= 28) return 'Hot. Slightly shorter walking tolerance.'
  return 'Comfortable walking weather. Streets and sidewalks are dry.'
}

/** The standing announcements every city starts with: what a resident would hear on the radio at the opening bell. */
export function baselineAnnouncements(session: LiveSession | null, pack: CityPack | null): LogEntry[] {
  const config = session?.config
  const people = config?.initial_population ?? 600
  const buses = config?.fleet_size ?? 2
  const temperature = config?.temperature_c ?? 20
  const city = pack?.name.split(',')[0] ?? 'the city'
  return [
    { id: 'base-open', at: 0, source: 'City Hall', title: `Good evening, ${city}`, body: `${plural(people, 'resident')} are on the move across downtown this hour. All city services are operating normally.` },
    { id: 'base-roads', at: 0, source: 'Roads', title: 'All major routes open', body: 'No closures reported. Front St W, Lake Shore Blvd W, King St W and the Gardiner are flowing.' },
    { id: 'base-transit', at: 0, source: 'Transit', title: `${plural(buses, 'shuttle bus', 'shuttle buses')} on standby`, body: `The shuttle fleet is waiting at the venue depot with ${buses * 60} seats between them. No routes have been assigned yet.` },
    { id: 'base-weather', at: 0, source: 'Weather', title: `${temperature}°C and clear`, body: weatherNote(temperature) },
  ]
}

/** One announcement per live change in the running city, in the voice of the department that would issue it. */
export function announcementFor(change: Intervention, at: number, id: string, session: LiveSession, pack: CityPack | null, corridors: Record<string, Corridor>): LogEntry | null {
  const zone = (zid?: string | null) => pack?.zones.find((z) => z.zone_id === zid)?.name ?? zid ?? 'downtown'
  switch (change.kind) {
    case 'close_road': {
      const name = streetName(change.edge_ids, corridors)
      return { id, at, source: 'Roads', title: `Road closure: ${name ?? plural(change.edge_ids.length, 'segment')}`, body: `${name ? `${name} is` : `${plural(change.edge_ids.length, 'road segment')} are`} closed to cars and buses until further notice. Barricades are in place; sidewalks stay open. Drivers are re-routing.` }
    }
    case 'reopen_road': {
      const name = streetName(change.edge_ids, corridors)
      return { id, at, source: 'Roads', title: `Reopened: ${name ?? plural(change.edge_ids.length, 'segment')}`, body: `Barricades removed. Traffic may use ${name ?? 'the street'} again.` }
    }
    case 'population':
      return { id, at, source: 'People', title: `${change.count.toLocaleString()} more travelers heading to ${zone(change.destination_zone_id)}`, body: `${change.origin_zone_id ? `Setting off from ${zone(change.origin_zone_id)}` : 'Setting off from across the other districts'}${change.release_window_s ? ` over the next ${Math.round(change.release_window_s / 60)} min` : ' all at once'}. ${Math.round(session.config.car_share * 100)}% have a car; the rest walk or ride.` }
    case 'temperature':
      return { id, at, source: 'Weather', title: `Temperature now ${change.temperature_c}°C`, body: weatherNote(change.temperature_c) }
    case 'development': {
      const counts = developmentCounts(change.spec)
      return { id, at, source: 'Planning', title: `New development: ${change.spec.name}`, body: `${developmentLabel(change.spec)} with ${plural(change.spec.capacity, change.spec.land_use === 'residential' ? 'home' : 'place')}. ${plural(counts.trips, 'one-way trip')} added from this site; ${counts.cars.toLocaleString()} by car.` }
    }
    case 'remove_development': {
      const standing = session.developments?.find((d) => d.development_id === change.development_id)
      return { id, at, source: 'Planning', title: `Demolished: ${standing?.spec.name ?? 'a development'}`, body: 'Travelers who had not set off yet were dropped; those already on their way are finishing their trips.' }
    }
    case 'add_bus_route':
      return { id, at, source: 'Transit', title: `${change.bus_id.replace('_', ' ')} assigned to a shuttle route`, body: `Serving ${plural(change.stop_ids.length, 'stop')} on a repeating loop. 60 seats.` }
    case 'incident': {
      const hazard = HAZARDS.find((h) => h.id === change.hazard)
      return { id, at, source: 'Emergency', title: `${change.label ?? hazard?.label ?? change.hazard} declared`, body: `${change.radius_m} m footprint. ${hazard?.detail ?? ''} Only people within the warning radius see it; everyone else hears it from a neighbour.` }
    }
    default:
      return null
  }
}

export function visualAnnouncement(event: VisualCityEvent): LogEntry {
  return { id: `visual-${event.id}`, at: event.track.start_s, source: 'Weather', title: `Tornado sighted near ${event.area}`, body: `${event.intensity[0].toUpperCase()}${event.intensity.slice(1)} intensity, ${Math.round(event.track.radius_m)} m across, tracking through until ${simClock(event.track.end_s)}. Visual event: it does not change measured journeys.`, visual: true }
}

/** Everything announced so far, newest first: live changes, visual events, then the standing baseline. */
export function cityLog(session: LiveSession | null, pack: CityPack | null, corridors: Record<string, Corridor>, visuals: VisualCityEvent[], t: number): LogEntry[] {
  const entries: LogEntry[] = []
  if (session) for (const command of session.commands) {
    if (command.at_s > t) continue
    const entry = announcementFor(command.intervention, command.at_s, command.command_id, session, pack, corridors)
    if (entry) entries.push(entry)
  }
  for (const event of visuals) if (event.track.start_s <= t) entries.push(visualAnnouncement(event))
  entries.sort((a, b) => b.at - a.at)
  return [...entries, ...baselineAnnouncements(session, pack)]
}

export default function CityLogPanel({ session, pack, corridors, visuals, time, onClose }: { session: LiveSession | null; pack: CityPack | null; corridors: Record<string, Corridor>; visuals: VisualCityEvent[]; time: number; onClose: () => void }) {
  const entries = useMemo(() => cityLog(session, pack, corridors, visuals, time), [session, pack, corridors, visuals, time])
  const live = entries.filter((e) => e.at > 0).length
  return (
    <GlassSurface className="gp-utility-panel gp-city-log" role="dialog" aria-label="City log">
      <header><h2>City log</h2><GlassIconButton icon="close" label="Close city log" onClick={onClose} /></header>
      <p className="gp-panel-subtitle">{live ? `${plural(live, 'announcement')} since the city opened.` : 'What residents are hearing. New announcements appear as the city changes.'}</p>
      <ol className="gp-log-list">
        {entries.map((entry) => (
          <li key={entry.id} className={`gp-log-entry${entry.visual ? ' is-visual' : ''}`}>
            <span className={`gp-log-icon gp-log-icon-${entry.source.replace(' ', '').toLowerCase()}`}><GodIcon name={ICONS[entry.source]} size={18} /></span>
            <div className="gp-log-copy">
              <div className="gp-log-meta"><time>{simClock(entry.at)}</time><span>{entry.source}</span>{entry.visual && <span className="gp-log-visual">visual</span>}</div>
              <b>{entry.title}</b>
              <p>{entry.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </GlassSurface>
  )
}
