import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Message } from '@shared/types'
import { errorText } from './errors'

type Point = Pick<Message, 'id' | 'text' | 'threadId'>

/** A session-local message picker: arrows browse, Enter chooses, Escape goes back. */
export function RewindDialog({ sessionId, onClose }: { sessionId: string; onClose(): void }): React.JSX.Element {
  const menu = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const [points, setPoints] = useState<Point[]>([])
  const [pick, setPick] = useState(0)
  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = points[pick]

  useEffect(() => {
    menu.current?.focus()
    let active = true
    void window.gloss.sessions.rewindPoints(sessionId).then(
      (items) => { if (active) { setPoints(items); setLoading(false) } },
      (err: unknown) => { if (active) { setError(errorText(err)); setLoading(false) } }
    )
    return () => { active = false }
  }, [sessionId])
  useEffect(() => {
    if (confirming) menu.current?.focus()
    else list.current?.focus()
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [pick, points, confirming])

  async function rewind(): Promise<void> {
    if (!selected || busy) return
    setBusy(true)
    setError(null)
    try { await window.gloss.sessions.rewind(sessionId, selected.id); onClose() }
    catch (err) { setError(errorText(err)); setBusy(false) }
  }

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="dialog rewind-menu" ref={menu} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Tab') { e.preventDefault(); return }
        if (e.key === 'Escape') {
          e.preventDefault()
          if (e.repeat) return
          if (!busy) {
            if (confirming) { setConfirming(false); setError(null) }
            else onClose()
          }
          return
        }
        if ((e.repeat && e.key === 'Enter') || busy || loading) return
        if (!confirming && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
          e.preventDefault()
          if (e.key === 'Home') setPick(0)
          else if (e.key === 'End') setPick(Math.max(0, points.length - 1))
          else setPick((at) => Math.max(0, Math.min(points.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))))
        }
        if (e.key === 'Enter' && selected) {
          e.preventDefault()
          if (confirming) void rewind()
          else setConfirming(true)
        }
      }}>
        <h2 id={`${id}-title`}>Rewind conversation</h2>
        {confirming && selected ? <>
          <p>Remove this message and all later conversation history across every thread?</p>
          <blockquote className="rewind-preview">{selected.text || '(Attachments only)'}</blockquote>
          <p className="muted">Project files stay unchanged. The agent starts fresh with the retained transcript. This cannot be undone.</p>
          <p className="rewind-keys">{busy ? 'Rewinding...' : 'Enter to rewind. Esc to go back.'}</p>
        </> : <>
          <p className="muted">Your messages in this session, newest first. Choose where to rewind.</p>
          {loading && <p role="status">Loading messages...</p>}
          {!loading && !points.length && !error && <p>No messages to rewind.</p>}
          <ul ref={list} tabIndex={0} role="listbox" aria-label="Messages in this session" aria-activedescendant={selected ? `${id}-${pick}` : undefined}>
            {points.map((point, index) => <li id={`${id}-${index}`} key={point.id} role="option" aria-selected={pick === index}
              className={pick === index ? 'on' : undefined} onMouseMove={() => setPick(index)} onClick={() => { setPick(index); setConfirming(true) }}>
              {point.threadId && <span className="rewind-thread">Thread</span>}
              {point.text || '(Attachments only)'}
            </li>)}
          </ul>
          <p className="rewind-keys">Up/Down to browse. Enter to choose. Esc to close.</p>
        </>}
        {error && <p role="alert" className="composer-error">{error}</p>}
      </div>
    </div>, document.body
  )
}
