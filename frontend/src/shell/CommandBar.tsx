import { useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { ghostFromProposal } from './ghost'
import ProposalCard from './ProposalCard'

const SUGGESTIONS = [
  'Close Front St W from 05:00 to 30:00',
  'Reopen Front St W',
  'Use three buses',
  'Storm corridor via the venue and Union Station 300 m from 10:00 to 25:00',
  'Move stop Bremner Blvd shuttle bay to Rees St shuttle bay',
]

export default function CommandBar() {
  const scenarioId = useStore((s) => s.scenarioId)
  const pack = useStore((s) => s.pack)
  const tool = useStore((s) => s.tool)
  const ghost = useStore((s) => s.ghost)
  const setGhost = useStore((s) => s.setGhost)
  const setError = useStore((s) => s.setError)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)

  const submit = async (prompt: string) => {
    if (!scenarioId || !prompt.trim()) return
    setBusy(true)
    try {
      setGhost(ghostFromProposal(await api.previewEdit(scenarioId, prompt), pack))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`command ${focused ? 'focused' : ''}`}>
      {ghost?.proposal && !tool && (
        <div className="command-proposal">
          <ProposalCard />
        </div>
      )}
      {focused && !text && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} onMouseDown={(e) => e.preventDefault()} onClick={() => void submit(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit(text)
        }}
      >
        <span className="prompt-glyph">{busy ? '◌' : '›'}</span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Describe an intervention — the agent proposes, you confirm"
          disabled={!scenarioId || busy}
        />
        <button type="submit" disabled={busy || !text.trim()}>
          Propose
        </button>
      </form>
    </div>
  )
}
