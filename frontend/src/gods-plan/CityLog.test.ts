import { describe, expect, it } from 'vitest'
import type { LiveSession } from '../live/types'
import type { CityPack } from '../types'
import { baselineAnnouncements, cityLog } from './CityLog'

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
    expect(log.slice(0, 3).map((e) => e.title)).toEqual(['Temperature now -20°C', '500 more travelers heading to Financial District', 'Road closure: Front St W'])
    expect(log[2].body).toContain('Barricades are in place')
    expect(log[0].body).toMatch(/Extreme cold/)
    // announcements are only made once the city has reached them
    expect(cityLog(s, pack, corridors, [], 200).map((e) => e.title)[0]).toBe('Road closure: Front St W')
  })
})
