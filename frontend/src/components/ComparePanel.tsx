import { useMemo } from 'react'
import { useStore } from '../store'
import type { RunMetrics } from '../types'
import { fmt } from '../util'

const ROWS: { key: keyof RunMetrics; label: string; fmt?: (v: number) => string; lowerBetter?: boolean }[] = [
  { key: 'completed', label: 'completed by horizon' },
  { key: 'unfinished_waiting', label: 'still waiting', lowerBetter: true },
  { key: 'unfinished_riding', label: 'still riding', lowerBetter: true },
  { key: 'unfinished_walking', label: 'still walking', lowerBetter: true },
  { key: 'unfinished_not_departed', label: 'never departed', lowerBetter: true },
  { key: 'unroutable', label: 'unroutable (compile)', lowerBetter: true },
  { key: 'waiting_person_minutes', label: 'waiting person-min', fmt: (v) => v.toFixed(0), lowerBetter: true },
  { key: 'completed_duration_median_s', label: 'median journey', fmt: (v) => fmt(v), lowerBetter: true },
  { key: 'completed_duration_p95_s', label: 'p95 journey', fmt: (v) => fmt(v), lowerBetter: true },
  { key: 'boardings', label: 'boardings' },
  { key: 'teleports', label: 'SUMO teleports', lowerBetter: true },
]

export default function ComparePanel() {
  const runs = useStore((s) => s.runs)
  const primaryRunId = useStore((s) => s.primaryRunId)
  const compareRunId = useStore((s) => s.compareRunId)
  const primary = useStore((s) => (s.primaryRunId ? s.replays[s.primaryRunId] : null))
  const compare = useStore((s) => (s.compareRunId ? s.replays[s.compareRunId] : null))
  const t = useStore((s) => s.t)
  const select = useStore((s) => s.select)

  const a = runs.find((r) => r.run_id === primaryRunId)?.metrics ?? null
  const b = runs.find((r) => r.run_id === compareRunId)?.metrics ?? null

  // Same-traveler comparison: arrival times of the cohort in both runs (same demand => same person ids).
  const diffs = useMemo(() => {
    if (!primary || !compare) return null
    const arrA: Record<string, number> = {}
    const arrB: Record<string, number> = {}
    for (const e of primary.bundle.events) if (e.event === 'arrive') arrA[e.person_id] = e.t
    for (const e of compare.bundle.events) if (e.event === 'arrive') arrB[e.person_id] = e.t
    const ids = new Set([...Object.keys(primary.personEvents), ...Object.keys(compare.personEvents)])
    const rows = [...ids].map((pid) => ({ pid, a: arrA[pid], b: arrB[pid] }))
    const both = rows.filter((r) => r.a !== undefined && r.b !== undefined)
    const onlyA = rows.filter((r) => r.a !== undefined && r.b === undefined).length
    const onlyB = rows.filter((r) => r.b !== undefined && r.a === undefined).length
    const neither = rows.filter((r) => r.a === undefined && r.b === undefined).length
    const saved = both.map((r) => r.b - r.a)
    saved.sort((x, y) => x - y)
    const median = saved.length ? saved[Math.floor(saved.length / 2)] : 0
    const biggest = [...both].sort((x, y) => y.b - y.a - (x.b - x.a)).slice(0, 5)
    return { both: both.length, onlyA, onlyB, neither, median, biggest }
  }, [primary, compare])

  if (!a) return null
  const val = (m: RunMetrics | null, row: (typeof ROWS)[number]) => {
    if (!m) return '—'
    const v = m[row.key]
    if (v === null || v === undefined) return '—'
    if (typeof v === 'number') return row.fmt ? row.fmt(v) : String(v)
    return String(v)
  }
  const better = (row: (typeof ROWS)[number]) => {
    if (!a || !b) return ''
    const va = a[row.key]
    const vb = b[row.key]
    if (typeof va !== 'number' || typeof vb !== 'number' || va === vb) return ''
    const aWins = row.lowerBetter ? va < vb : va > vb
    return aWins ? 'better' : 'worse'
  }

  return (
    <div className="compare">
      <h2>
        Measured outcomes <span className="dim small">at horizon; cohort {a.cohort_size}</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th></th>
            <th className="mono">{primaryRunId?.slice(0, 16)} (view)</th>
            {b && <th className="mono">{compareRunId?.slice(0, 16)} (compare)</th>}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.key}>
              <td>{row.label}</td>
              <td className={better(row)}>{val(a, row)}</td>
              {b && <td>{val(b, row)}</td>}
            </tr>
          ))}
          <tr>
            <td>peak occupancy</td>
            <td className="mono">{Object.entries(a.max_occupancy).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}</td>
            {b && <td className="mono">{Object.entries(b.max_occupancy).map(([k, v]) => `${k}:${v}`).join(' ') || '—'}</td>}
          </tr>
        </tbody>
      </table>
      {diffs && (
        <div className="small">
          <b>same travelers, both runs</b>
          <div className="dim">
            arrived in both {diffs.both} · only in view {diffs.onlyA} · only in compare {diffs.onlyB} · neither {diffs.neither}
          </div>
          <div>median saved by view vs compare: {diffs.median >= 0 ? '+' : '−'}{fmt(Math.abs(diffs.median))}</div>
          <div className="wrap">
            {diffs.biggest.map((r) => (
              <button key={r.pid} className="tiny" onClick={() => select({ kind: 'person', id: r.pid })} title={`view ${fmt(r.a)} vs compare ${fmt(r.b)}`}>
                {r.pid} {r.b - r.a >= 0 ? '+' : '−'}{fmt(Math.abs(r.b - r.a))}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="small dim">
        t={fmt(t)} · warnings: {a.warnings.length}
        <details>
          <summary>show</summary>
          {a.warnings.map((w, i) => (
            <div key={i} className={w.startsWith('RESTRICTION') ? 'bad' : ''}>
              {w}
            </div>
          ))}
        </details>
      </div>
    </div>
  )
}
