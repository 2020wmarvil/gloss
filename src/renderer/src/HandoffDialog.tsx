import { useEffect, useRef, useState } from 'react'
import { handoffSummary, handoffText, MAX_HANDOFF_CHARS, type HandoffRequest } from '@shared/handoff'
import type { AgentInfo, Session } from '@shared/types'
import type { OpenSession } from './App'
import { errorText } from './errors'

type Props = {
  open: OpenSession
  threadId: string | null
  agents: AgentInfo[]
  running: boolean
  onClose(): void
  onCreated(session: Session): void
}

export function HandoffDialog({ open, threadId, agents, running, onClose, onCreated }: Props): React.JSX.Element {
  const destinations = agents.filter((a) => a.id !== open.session.agentId)
  const thread = open.threads.find((t) => t.id === threadId)
  const available = open.messages.filter((m) => threadId === null || m.threadId === threadId)
  const [agentId, setAgentId] = useState(destinations[0]?.id ?? '')
  const [summary, setSummary] = useState(() => handoffSummary(open.session, thread, available))
  const [selected, setSelected] = useState(() => new Set(available.slice(-12).map((m) => m.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const messages = available.filter((m) => selected.has(m.id))
  const preview = handoffText(open.session, thread, summary, messages, open.threads)
  const tooLarge = preview.length > MAX_HANDOFF_CHARS || messages.length > 200
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLSelectElement>('select')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])

  async function create(): Promise<void> {
    setBusy(true)
    setError(null)
    const request: HandoffRequest = { sessionId: open.session.id, threadId, agentId, summary, messageIds: messages.map((m) => m.id) }
    try { onCreated(await window.gloss.sessions.handoff(request)) }
    catch (err) { setError(errorText(err)); setBusy(false) }
  }

  return <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
    <div className="dialog handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title" ref={ref}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); if (!busy) onClose() }
        if (e.key === 'Tab') {
          const controls = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')]
          const first = controls[0], last = controls.at(-1)
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
      <header className="search-heading"><h2 id="handoff-title">Continue with another agent</h2><button disabled={busy} onClick={onClose}>Cancel</button></header>
      <p className="muted">Creates a new session in this project with a link back to {thread ? 'this thread' : 'this conversation'}.</p>
      <label>Agent <select aria-label="Destination agent" value={agentId} disabled={busy} onChange={(e) => setAgentId(e.target.value)}>
        {destinations.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select></label>
      <label htmlFor="handoff-summary">Summary (edit before continuing)</label>
      <textarea id="handoff-summary" rows={5} maxLength={16000} value={summary} disabled={busy} onChange={(e) => setSummary(e.target.value)} />
      <div className="handoff-selection-heading"><strong>Include messages ({messages.length})</strong>
        <button disabled={busy} onClick={() => setSelected(new Set(available.slice(-200).map((m) => m.id)))}>Select {available.length > 200 ? 'latest 200' : 'all'}</button>
        <button disabled={busy} onClick={() => setSelected(new Set())}>Clear selection</button>
      </div>
      <div className="handoff-messages">
        {available.map((m) => <label key={m.id}>
          <input type="checkbox" checked={selected.has(m.id)} disabled={busy} onChange={(e) => setSelected((prev) => {
            const next = new Set(prev)
            if (e.target.checked) next.add(m.id); else next.delete(m.id)
            return next
          })} />
          <span><strong>{m.role === 'user' ? 'You' : 'Agent'}</strong> / {m.threadId ? `Thread: ${open.threads.find((t) => t.id === m.threadId)?.anchor.text ?? 'unavailable anchor'}` : 'Main'}<br />
            <span className="muted">{m.text.slice(0, 240)}{m.text.length > 240 ? '...' : ''}</span>
          </span>
        </label>)}
        {available.length === 0 && <p className="muted">No messages yet. You can continue with the summary alone.</p>}
      </div>
      <p className="muted">Messages are copied as text. Attachments and tool output stay in the source session.</p>
      <details className="handoff-preview" open><summary>Preview what will be sent</summary><pre>{preview}</pre></details>
      {running && <p role="alert">Wait for the source turn to finish before creating a handoff.</p>}
      {tooLarge && <p role="alert">Select at most 200 messages and {MAX_HANDOFF_CHARS.toLocaleString()} characters of context.</p>}
      {error && <p role="alert" className="dialog-error">{error}</p>}
      <footer><button className="primary" disabled={busy || running || !agentId || !summary.trim() || tooLarge} onClick={() => void create()}>
        {busy ? 'Creating handoff...' : 'Create handoff'}
      </button></footer>
    </div>
  </div>
}
