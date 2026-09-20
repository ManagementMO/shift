import { afterEach, describe, expect, it } from 'vitest'
import { MAX_LASER_STRIKES } from '../babylon/orbitalLaserModel'
import { useGodVisuals } from './state'

const event = (id = 'laser') => ({ strike: { id, x: 0, z: 0, radius: 150, firedAt: 5 }, area: 'Toronto' })
afterEach(() => useGodVisuals.getState().clear())

describe('visual orbital event state', () => {
  it('disarms after firing and preserves the cleared event after its animation finishes', () => {
    useGodVisuals.getState().setArmed(true)
    expect(useGodVisuals.getState().addLaser(event())).toBe(true)
    expect(useGodVisuals.getState().armed).toBe(false)
    expect(useGodVisuals.getState().lastKind).toBe('orbital')
    useGodVisuals.getState().completeLaser('laser', { buildings: 7, entities: 10, developments: 1 })
    expect(useGodVisuals.getState().lasers).toHaveLength(1)
    expect(useGodVisuals.getState().lasers[0].impact?.buildings).toBe(7)
  })

  it('rejects duplicate, invalid and over-budget strikes without evicting cleared areas', () => {
    expect(useGodVisuals.getState().addLaser({ ...event(), strike: { ...event().strike, radius: NaN } })).toBe(false)
    expect(useGodVisuals.getState().addLaser({ ...event(), strike: { ...event().strike, x: Infinity } })).toBe(false)
    expect(useGodVisuals.getState().addLaser({ ...event(), strike: { ...event().strike, radius: 1001 } })).toBe(false)
    expect(useGodVisuals.getState().addLaser(event())).toBe(true)
    expect(useGodVisuals.getState().addLaser(event())).toBe(false)
    for (let i = 1; i < MAX_LASER_STRIKES; i++) expect(useGodVisuals.getState().addLaser(event(String(i)))).toBe(true)
    expect(useGodVisuals.getState().addLaser(event('overflow'))).toBe(false)
    expect(useGodVisuals.getState().lasers[0].strike.id).toBe('laser')
  })

  it('keeps shots while the same city is open and clears them on a different session', () => {
    useGodVisuals.getState().setScope('toronto:one')
    useGodVisuals.getState().addLaser(event())
    useGodVisuals.getState().setScope('toronto:one')
    expect(useGodVisuals.getState().lasers).toHaveLength(1)
    useGodVisuals.getState().setScope('toronto:two')
    expect(useGodVisuals.getState().lasers).toEqual([])
    expect(useGodVisuals.getState().lastKind).toBeNull()
  })

  it('restores individual strikes and ignores late completion after restoration', () => {
    useGodVisuals.getState().addLaser(event('one'))
    useGodVisuals.getState().addLaser(event('two'))
    useGodVisuals.getState().removeLaser('two')
    useGodVisuals.getState().completeLaser('two', { buildings: 1, entities: 0, developments: 0 })
    expect(useGodVisuals.getState().lasers.map(e => e.strike.id)).toEqual(['one'])
    useGodVisuals.getState().clear()
    expect(useGodVisuals.getState().lasers).toEqual([])
    expect(useGodVisuals.getState().armed).toBe(false)
  })
})
