import { elapsed } from './timeline'
import type { LiveSession } from './types'

const HOP_LABEL = ['Saw it', 'Heard first-hand', 'Heard second-hand', 'Heard third-hand', 'Fourth-hand', 'Fifth-hand', 'Sixth-hand']

/** How the swarm is reacting: who saw an incident, who heard about it, who changed plans. All values are measured in SUMO. */
export default function SwarmPanel({ session, time, onSeek }: { session: LiveSession; time: number; onSeek: (t: number) => void }) {
  const swarm = session.metrics?.swarm
  const incidents = session.incidents ?? []
  const active = incidents.filter(i => i.start_s <= time && time < i.end_s)
  if (!swarm || !incidents.length) return null
  const hops = Object.entries(swarm.by_hop).map(([hop, n]) => [Number(hop), n] as const).sort((a, b) => a[0] - b[0])
  const total = Math.max(1, ...hops.map(([, n]) => n))
  return <aside className="live-inspector live-swarm" aria-label="Swarm response">
    <div className="live-panel-heading"><div><span className="live-eyebrow">Agent-to-agent news</span><h2>{active.length ? active.map(i => i.label).join(', ') : 'Incidents over'}</h2></div></div>
    <dl className="live-model-factors">
      <div><dt>Saw an incident</dt><dd>{swarm.witnessed.toLocaleString()}</dd></div>
      <div><dt>Messages passed</dt><dd>{swarm.messages.toLocaleString()}</dd></div>
      <div><dt>Know right now</dt><dd>{swarm.aware_total.toLocaleString()}</dd></div>
      <div><dt>Changed plans</dt><dd>{swarm.responded.toLocaleString()}</dd></div>
      <div><dt>Inside a footprint</dt><dd>{swarm.in_zone.toLocaleString()}</dd></div>
    </dl>
    <div className="live-hops" role="img" aria-label={hops.map(([hop, n]) => `${HOP_LABEL[hop] ?? `Hop ${hop}`}: ${n}`).join(', ')}>
      {hops.map(([hop, n]) => <div key={hop} className="live-hop"><span>{HOP_LABEL[hop] ?? `Hop ${hop}`}</span><i className={`hop-${Math.min(hop, 3)}`} style={{ width: `${Math.max(3, n / total * 100)}%` }} /><b>{n}</b></div>)}
    </div>
    <ul className="live-feed">{swarm.feed.slice(-6).reverse().map((entry, i) => <li key={`${entry.t}-${i}`}><button onClick={() => onSeek(entry.t)}><time>+{elapsed(entry.t)}</time>{entry.text}</button></li>)}</ul>
    <p className="live-assumption">Witnesses inside the warning radius post to the incident topic. Everyone else learns from neighbours within earshot, one hop per second. Envelopes carry openJiuwen message fields.</p>
  </aside>
}
