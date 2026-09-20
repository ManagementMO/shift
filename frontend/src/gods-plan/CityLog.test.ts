import { describe, expect, it } from 'vitest'
import type { LiveSession } from '../live/types'
import type { CityPack } from '../types'
import { baselineAnnouncements, cityLog, scheduledAnnouncements } from './CityLog'

const pack = { name: 'Toronto, ON', zones: [{ zone_id: 'fin', name: 'Financial District' }, { zone_id: 'west', name: 'Liberty Village' }] } as unknown as CityPack
const corridors = { front: { label: 'Front St W', edge_ids: ['a', 'b'] } }
const session = (commands: LiveSession['commands']): LiveSession =>
  ({ config: { initial_population: 600, fleet_size: 2, temperature_c: 20, car_share: 0.35 }, commands, developments: [] }) as unknown as LiveSession

describe('City log', () => {
  it('opens with the standing announcements for the city as configured', () => {
    const base = baselineAnnouncements(session([]), pack)
    expect(base.map((e) => e.source)).toEqual(['City Hall', 'Roads', 'Transit', 'Weather'])
    expect(base[0].title).toBe('Good evening, Toronto')
    expect(base[2].title).toBe('2 shuttle buses on standby')
  })

  it('announces each live change newest first, naming the street when it knows it', () => {
    const s = session([
      { command_id: 'c1', at_s: 120, expected_revision: 0, intervention: { kind: 'close_road', edge_ids: ['a', 'b'], until_s: null } },
      { command_id: 'c2', at_s: 300, expected_revision: 1, intervention: { kind: 'population', count: 500, destination_zone_id: 'fin', origin_zone_id: null, release_window_s: 300 } },
      { command_id: 'c3', at_s: 900, expected_revision: 2, intervention: { kind: 'temperature', temperature_c: -20 } },
    ])
    const log = cityLog(s, pack, corridors, [], 1000)
    const changes = log.filter((e) => e.id.startsWith('c'))
    expect(changes.map((e) => e.title)).toEqual(['Temperature now -20°C', '500 more travelers heading to Financial District', 'Road closure: Front St W'])
    expect(changes[2].body).toContain('Barricades are in place')
    expect(changes[0].body).toMatch(/Extreme cold/)
    // announcements are only made once the city has reached them; the scheduled bulletins interleave by time
    expect(cityLog(s, pack, corridors, [], 200).map((e) => e.title).slice(0, 2)).toEqual(['Road closure: Front St W', '600 people leave the venue at once'])
  })

  it('breaks hard-coded news and safety alerts as the evening unfolds, and reports how word of an incident spreads', () => {
    const scheduled = scheduledAnnouncements(session([]), pack)
    expect(scheduled.map((e) => e.kind ?? 'notice')).toEqual(['breaking', 'alert', 'notice', 'breaking', 'notice', 'breaking'])
    expect(scheduled[1]).toMatchObject({ source: 'Alert Ready', title: 'Heavy pedestrian traffic downtown' })
    const s = { ...session([{ command_id: 'c1', at_s: 100, expected_revision: 0, intervention: { kind: 'incident', hazard: 'storm', lon: -79.38, lat: 43.64, radius_m: 150 } }]), metrics: { swarm: { events: [{ event_id: 'ev-1', hazard: 'storm', label: 'Storm', radius_m: 150, ended: false, aware: 42, edges: 12, start_s: 100 }] } } } as unknown as LiveSession
    const early = cityLog(s, pack, corridors, [], 120)
    expect(early[0]).toMatchObject({ kind: 'alert', source: 'Alert Ready', title: 'Storm declared' })
    expect(early.some((e) => e.id === 'spread-ev-1')).toBe(false)
    const later = cityLog(s, pack, corridors, [], 200)
    expect(later[0]).toMatchObject({ id: 'spread-ev-1', kind: 'breaking', title: 'Word of the storm is spreading' })
    expect(later[0].body).toContain('42 residents')
    // the standing baseline stays at the bottom
    expect(later.slice(-4).map((e) => e.source)).toEqual(['City Hall', 'Roads', 'Transit', 'Weather'])
  })
})
