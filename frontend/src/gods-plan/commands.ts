export type CityCommand = 'plane' | 'agents' | 'tornado' | 'temperature' | 'population' | 'development' | 'closure' | 'unsupported'

export function cityCommand(text: string, agentsLocked: boolean): CityCommand {
  if (/\b(?:air|aero)?planes?\b/i.test(text)) return 'plane'
  if (agentsLocked && /\b(ai|agents?|swarms?|evacuat\w*|rescue|police|responders?|dispatch|patrol|secure|protect|guide|message)\b/i.test(text)) return 'agents'
  if (/tornado/i.test(text)) return 'tornado'
  if (/weather|temperature|cold|heat/i.test(text)) return 'temperature'
  if (/population|people|crowd/i.test(text)) return 'population'
  if (/build|apartment|park|office|development/i.test(text)) return 'development'
  if (/road|close|traffic|bus|transit|gardiner/i.test(text)) return 'closure'
  return agentsLocked ? 'agents' : 'unsupported'
}
