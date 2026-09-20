import { describe, expect, it } from 'vitest'
import { cityCommand } from './commands'

describe('local city commands', () => {
  it.each(['plane', 'A PLANE flies over the city!', 'Show me a plane.', 'two planes overhead', 'fly an airplane', 'An aeroplane over Toronto'])('recognizes %s without an AI provider', text => {
    expect(cityCommand(text, true)).toBe('plane')
    expect(cityCommand(text, false)).toBe('plane')
  })

  it('gives the demo flyover priority over agent and city-tool keywords', () => {
    expect(cityCommand('Ask the agents to watch a plane over the road and buildings', true)).toBe('plane')
    expect(cityCommand('A plane over the crowd in cold weather', false)).toBe('plane')
  })

  it.each(['planet', 'Explain the city', 'planetary weather', 'planned development', 'airplanespotting', ''])('does not mistake %s for an aircraft', text => {
    expect(cityCommand(text, false)).not.toBe('plane')
  })

  it.each([
    ['storm', 'storm'], ['lightning', 'storm'], ['thunder', 'storm'],
    ['rain', 'rain'], ['downpour', 'rain'], ['flood', 'flood'],
    ['fire', 'wildfire'], ['blaze', 'wildfire'],
  ])('preserves the live event command %s', (text, action) => {
    expect(cityCommand(text, true)).toBe(action)
    expect(cityCommand(text, false)).toBe(action)
    expect(cityCommand(`a plane above the ${text}`, true)).toBe('plane')
  })

  it('preserves the existing tools and agent demo lock', () => {
    expect(cityCommand('a tornado', true)).toBe('tornado')
    expect(cityCommand('cold weather', true)).toBe('temperature')
    expect(cityCommand('more people', true)).toBe('population')
    expect(cityCommand('build apartments', true)).toBe('development')
    expect(cityCommand('close this road', true)).toBe('closure')
    expect(cityCommand('dispatch agents', true)).toBe('agents')
    expect(cityCommand('something else', true)).toBe('agents')
    expect(cityCommand('something else', false)).toBe('unsupported')
  })
})
