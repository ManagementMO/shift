import { useMemo } from 'react'
import { developmentCounts, developmentLabel } from '../development'
import { HAZARDS, type Intervention, type LiveSession } from '../live/types'
import type { VisualCityEvent } from './state'
import { simClock } from '../world/playback'
import type { CityPack, Corridor } from '../types'
import { GlassIconButton, GlassSurface } from './ui'
import { GodIcon } from './icons'

export type LogSource = 'Roads' | 'Transit' | 'Planning' | 'People' | 'Weather' | 'Emergency' | 'City Hall' | 'City News' | 'Alert Ready'
/** breaking: a newsroom bulletin; alert: a public-safety alert. Plain notices have no kind. */
export type LogKind = 'breaking' | 'alert'

export interface LogEntry {
  id: string
  /** simulated seconds; entries are shown newest first */
  at: number
  source: LogSource
  title: string
  body: string
  kind?: LogKind
  /** a visual-only event (not measured by SUMO) */
  visual?: boolean
}

const ICONS: Record<LogSource, string> = { Roads: 'route', Transit: 'bus', Planning: 'building', People: 'users', Weather: 'cloud', Emergency: 'warning', 'City Hall': 'globe', 'City News': 'activity', 'Alert Ready': 'shield' }
const KIND_LABEL: Record<LogKind, string> = { breaking: 'Breaking', alert: 'Safety alert' }

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

/**
 * Hard-coded bulletins that break as the evening unfolds, whatever the user does: the opening rush, a safety alert
 * for the crowds, transit and traffic updates. Each appears once the city reaches its time.
 */
export function scheduledAnnouncements(session: LiveSession | null, pack: CityPack | null): LogEntry[] {
  const config = session?.config
  const people = config?.initial_population ?? 600
  const buses = config?.fleet_size ?? 2
  const city = pack?.name.split(',')[0] ?? 'the city'
  const zones = pack?.zones.map((z) => z.name) ?? []
  const destinations = zones.length >= 2 ? `${zones.slice(0, -1).join(', ')} and ${zones.at(-1)}` : zones[0] ?? 'the surrounding districts'
  return [
    { id: 'sched-rush', at: 90, source: 'City News', kind: 'breaking', title: `${plural(people, 'person', 'people')} leave the venue at once`, body: `The event has let out. Reporters on Front St W describe sidewalks shoulder to shoulder and cars queuing out of the parking decks. Everyone is heading for ${destinations}.` },
    { id: 'sched-pedestrians', at: 240, source: 'Alert Ready', kind: 'alert', title: 'Heavy pedestrian traffic downtown', body: 'Large crowds are on foot around the venue for the next half hour. Drivers: slow down and expect people in the roadway at crossings. Walkers: stay on the sidewalks and keep moving.' },
    { id: 'sched-transit', at: 600, source: 'Transit', title: buses ? 'First shuttles fill within minutes' : 'No shuttles running tonight', body: buses ? `${plural(buses, 'shuttle bus', 'shuttle buses')} are working the venue stops with 60 seats each. Queues are forming; those who can are walking.` : 'The fleet is idle. Tonight the crowd is walking and driving.' },
    { id: 'sched-traffic', at: 1200, source: 'City News', kind: 'breaking', title: 'Downtown traffic slow to clear', body: 'Twenty minutes in, the first arrivals are reaching their districts while the streets nearest the venue are still the slowest in the city. Police are waving cars through the busiest crossings.' },
    { id: 'sched-services', at: 1800, source: 'City Hall', title: 'Half-hour check-in', body: `${city} services report no incidents beyond the ones announced here. Streets, sidewalks and the shuttle loop are operating as described above.` },
    { id: 'sched-late', at: 2700, source: 'City News', kind: 'breaking', title: 'Most of the crowd is home', body: 'The bulk of the evening crowd has reached its destination. Stragglers are still walking in from the venue; the last shuttle runs continue until the simulation horizon.' },
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
      const name = change.label ?? hazard?.label ?? change.hazard
      if (change.hazard === 'rain') return { id, at, source: 'Weather', title: `${name} over downtown`, body: `A downpour ${change.radius_m} m across. Streets stay open; people caught in it will tell their neighbours.` }
      return { id, at, source: 'Alert Ready', kind: 'alert', title: `${name} declared`, body: `Avoid the area within ${change.radius_m} m. ${hazard?.detail ?? ''} Only people within the warning radius see it; everyone else hears it from a neighbour.` }
    }
    default:
      return null
  }
}

export function visualAnnouncement(event: VisualCityEvent): LogEntry {
  return { id: `visual-${event.id}`, at: event.track.start_s, source: 'Weather', title: `Tornado sighted near ${event.area}`, body: `${event.intensity[0].toUpperCase()}${event.intensity.slice(1)} intensity, ${Math.round(event.track.radius_m)} m across, tracking through until ${simClock(event.track.end_s)}. Visual event: it does not change measured journeys.`, visual: true }
}

/** A minute after an incident, the newsroom reports how far word of it has spread (measured by the swarm layer). */
export function spreadBulletins(session: LiveSession | null, t: number): LogEntry[] {
  const out: LogEntry[] = []
  for (const event of session?.metrics?.swarm?.events ?? []) {
    const at = event.start_s + 60
    if (at > t || event.aware <= 0) continue
    out.push({ id: `spread-${event.event_id}`, at, source: 'City News', kind: 'breaking', title: `Word of the ${event.label.toLowerCase()} is spreading`, body: `${plural(event.aware, 'resident')} know about it so far: some saw it, the rest heard from someone nearby. ${event.ended ? 'It has since ended.' : 'It is still under way.'}` })
  }
  return out
}

/** Everything announced so far, newest first: live changes, bulletins, visual events, then the standing baseline. */
export function cityLog(session: LiveSession | null, pack: CityPack | null, corridors: Record<string, Corridor>, visuals: VisualCityEvent[], t: number): LogEntry[] {
  const entries: LogEntry[] = []
  if (session) for (const command of session.commands) {
    if (command.at_s > t) continue
    const entry = announcementFor(command.intervention, command.at_s, command.command_id, session, pack, corridors)
    if (entry) entries.push(entry)
  }
  entries.push(...spreadBulletins(session, t))
  entries.push(...scheduledAnnouncements(session, pack).filter((e) => e.at <= t))
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
          <li key={entry.id} className={`gp-log-entry${entry.visual ? ' is-visual' : ''}${entry.kind ? ` is-${entry.kind}` : ''}`}>
            <span className={`gp-log-icon gp-log-icon-${entry.source.replace(' ', '').toLowerCase()}`}><GodIcon name={ICONS[entry.source]} size={18} /></span>
            <div className="gp-log-copy">
              <div className="gp-log-meta"><time>{simClock(entry.at)}</time><span>{entry.source}</span>{entry.kind && <span className={`gp-log-kind gp-log-kind-${entry.kind}`}>{KIND_LABEL[entry.kind]}</span>}{entry.visual && <span className="gp-log-visual">visual</span>}</div>
              <b>{entry.title}</b>
              <p>{entry.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </GlassSurface>
  )
}
