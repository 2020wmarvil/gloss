import { useEffect, useRef, useState } from 'react'
import type { PreparedHandoff } from '@shared/handoff'
import type { AgentInfo, Session } from '@shared/types'
import type { OpenSession } from './App'
import { Markdown } from './Markdown'
import { errorText } from './errors'

type Props = {
  open: OpenSession
  threadId: string | null
  agents: AgentInfo[]
  onClose(): void
  onCreated(session: Session): void
}

export function HandoffDialog({ open, threadId, agents, onClose, onCreated }: Props): React.JSX.Element {
  const sourceId = open.session.id
  const destinations = agents.filter((a) => a.id !== open.session.agentId)
  const sourceName = agents.find((a) => a.id === open.session.agentId)?.name ?? open.session.agentId
  const [agentId, setAgentId] = useState(destinations[0]?.id ?? '')
  const [prepared, setPrepared] = useState<PreparedHandoff | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [preparing, setPreparing] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLSelectElement>('select')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    let active = true, started = false
    let preparedId: string | undefined
    setPrepared(null)
    setError(null)
    setPreparing(true)
    // StrictMode's first setup/cleanup must not spend an extra source-agent turn.
    const timer = setTimeout(() => {
      started = true
      void window.gloss.sessions.prepareHandoff(sourceId, threadId).then((draft) => {
        preparedId = draft.id
        if (active) setPrepared(draft)
        else void window.gloss.sessions.discardHandoff(draft.id).catch(() => {})
      }).catch((err: unknown) => { if (active) setError(errorText(err)) })
        .finally(() => { if (active) setPreparing(false) })
    }, 0)
    return () => {
      active = false
      clearTimeout(timer)
      if (preparedId) void window.gloss.sessions.discardHandoff(preparedId).catch(() => {})
      else if (started) void window.gloss.sessions.cancelHandoffPreparation(sourceId).catch(() => {})
    }
  }, [sourceId, threadId, attempt])

  async function create(): Promise<void> {
    if (!prepared) return
    setBusy(true)
    setError(null)
    try { onCreated(await window.gloss.sessions.handoff({ preparedId: prepared.id, agentId })) }
    catch (err) { setError(errorText(err)); setBusy(false) }
  }

  return <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
    <div className="dialog handoff-dialog" role="dialog" aria-modal="true" aria-labelledby="handoff-title" ref={ref}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); if (!busy) onClose() }
        if (e.key === 'Tab') {
          const controls = [...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), summary')]
          const first = controls[0], last = controls.at(-1)
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
      <header className="search-heading"><h2 id="handoff-title">Continue with another agent</h2><button disabled={busy} onClick={onClose}>Cancel</button></header>
      <p className="muted">Creates a new session in this project with a link back to {threadId ? 'this thread' : 'this conversation'}.</p>
      <label>Agent <select aria-label="Destination agent" value={agentId} disabled={busy} onChange={(e) => setAgentId(e.target.value)}>
        {destinations.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select></label>
      {preparing ? <p role="status">Generating a handoff summary with {sourceName}...</p> : prepared && <>
        {prepared.fallbackReason === 'usage' && <p role="status">{sourceName} hit a usage limit. Using the local blurb.</p>}
        {prepared.fallbackReason === 'empty' && <p role="status">No discussion to summarize yet. Using a short blurb.</p>}
        <strong>{prepared.summaryKind === 'agent' ? 'Summary from the source agent' : 'Local blurb'}</strong>
        <div className="handoff-summary"><Markdown text={prepared.summary} /></div>
        <p className="muted">The destination agent will read a saved transcript of {threadId ? 'this thread and its anchor' : 'this conversation and its threads'} for the full context.</p>
        <details className="handoff-preview"><summary>Preview what will be sent</summary><pre>{prepared.prompt}</pre></details>
      </>}
      <p className="muted">Generating a summary uses one source-agent turn and records it in the source conversation. Transcript snapshots include tool output and text attachments; images are listed by name.</p>
      {error && <p role="alert" className="dialog-error">{error}</p>}
      {!preparing && !prepared && <button onClick={() => setAttempt((a) => a + 1)}>Retry summary</button>}
      <footer><button className="primary" disabled={busy || preparing || !agentId || !prepared} onClick={() => void create()}>
        {busy ? 'Creating handoff...' : 'Continue'}
      </button></footer>
    </div>
  </div>
}
