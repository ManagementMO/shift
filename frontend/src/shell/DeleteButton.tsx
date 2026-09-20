import { useEffect, useState } from 'react'

/**
 * Two-step delete: the first click arms it, the second confirms. Shared by the info bubble and the development panel
 * so a confirmed building never disappears on a single stray click.
 */
export function DeleteButton({ label, prompt, onConfirm, busy }: { label: string; prompt: string; onConfirm: () => void; busy: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const id = setTimeout(() => setArmed(false), 6000)
    return () => clearTimeout(id)
  }, [armed])
  if (busy) return <button className="ghostbtn danger" disabled>Deleting…</button>
  if (!armed) return <button className="ghostbtn danger" onClick={() => setArmed(true)}>{label}</button>
  return <span className="delete-confirm">
    <span className="small">{prompt}</span>
    <button className="primary danger" onClick={onConfirm}>Yes, delete</button>
    <button className="ghostbtn" onClick={() => setArmed(false)}>Keep</button>
  </span>
}
