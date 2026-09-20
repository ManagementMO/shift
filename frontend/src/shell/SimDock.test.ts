import { describe, expect, it } from 'vitest'
import { timelineTicks } from '../util'

describe('replay timeline labels', () => {
  it('includes the exact end of partial and non-round replays', () => {
    expect(timelineTicks(51)).toEqual([0, 51])
    expect(timelineTicks(2700)).toEqual([0, 600, 1200, 1800, 2400, 2700])
  })

  it('does not duplicate the final label on a full-hour replay', () => {
    expect(timelineTicks(3600)).toEqual([0, 600, 1200, 1800, 2400, 3000, 3600])
  })
})
