export type CityCommand = 'plane' | 'agents' | 'tornado' | 'storm' | 'rain' | 'flood' | 'wildfire' | 'temperature' | 'population' | 'development' | 'closure' | 'unsupported'

export function cityCommand(text: string, agentsLocked: boolean): CityCommand {
  if (/\b(?:air|aero)?planes?\b/i.test(text)) return 'plane'
  if (agentsLocked && /\b(ai|agents?|swarms?|evacuat\w*|rescue|police|responders?|dispatch|patrol|secure|protect|guide|message)\b/i.test(text)) return 'agents'
  if (/tornado/i.test(text)) return 'tornado'
  if (/storm|lightning|thunder/i.test(text)) return 'storm'
  if (/rain|downpour/i.test(text)) return 'rain'
  if (/flood/i.test(text)) return 'flood'
  if (/fire|blaze/i.test(text)) return 'wildfire'
  if (/weather|temperature|cold|heat/i.test(text)) return 'temperature'
  if (/population|people|crowd/i.test(text)) return 'population'
  if (/build|apartment|park|office|development/i.test(text)) return 'development'
  if (/road|close|traffic|bus|transit|gardiner/i.test(text)) return 'closure'
  return agentsLocked ? 'agents' : 'unsupported'
}
