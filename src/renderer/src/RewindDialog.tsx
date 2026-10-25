import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import type { RewindDraft, RewindPoint } from '@shared/composer'
import { errorText } from './errors'

/** A session-local message picker: arrows browse, Enter chooses, Escape closes. */
export function RewindDialog({ sessionId, onClose, onRewind, running = false }: { sessionId: string; running?: boolean; onClose(): void; onRewind?(draft: RewindDraft): void }): React.JSX.Element | null {
  const menu = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const [points, setPoints] = useState<RewindPoint[]>([])
  const [pick, setPick] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = points[pick]
  const autoRewound = useRef(false)

  useEffect(() => {
    menu.current?.focus()
    if (running) return
    let active = true
    void window.gloss.sessions.rewindPoints(sessionId).then(
      (items) => { if (active) { setPoints(items); setLoading(false) } },
      (err: unknown) => { if (active) { setError(errorText(err)); setLoading(false) } }
    )
    return () => { active = false }
  }, [sessionId, running])
  useEffect(() => {
    list.current?.focus()
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [pick, points])

  const rewind = useCallback(async (point = selected): Promise<void> => {
    if (!point || busy) return
    setBusy(true)
    setError(null)
    try {
      const draft = await window.gloss.sessions.rewind(sessionId, point.id)
      onRewind?.(draft)
      onClose()
    }
    catch (err) { setError(errorText(err)); setBusy(false) }
  }, [selected, busy, sessionId, onRewind, onClose])

  useEffect(() => {
    if (loading || running || autoRewound.current || points[0]?.outcome !== 'cancelled') return
    autoRewound.current = true
    void rewind(points[0])
  }, [loading, running, points, rewind])

  // Automatic rewind is a composer action, not a modal loading screen.
  if (!error && (loading || running || points[0]?.outcome === 'cancelled')) return null

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="dialog rewind-menu" ref={menu} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Tab') {
          e.preventDefault()
          const targets = [...menu.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')]
          const current = targets.indexOf(document.activeElement as HTMLElement)
          targets[(current + (e.shiftKey ? targets.length - 1 : 1)) % targets.length]?.focus()
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          if (e.repeat) return
          if (!busy) onClose()
          return
        }
        if ((e.repeat && e.key === 'Enter') || busy || loading) return
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          if (e.key === 'Home') setPick(0)
          else if (e.key === 'End') setPick(Math.max(0, points.length - 1))
          else setPick((at) => Math.max(0, Math.min(points.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))))
        }
        if (e.key === 'Enter' && selected) {
          e.preventDefault()
          void rewind()
        }
      }}>
        <header className="rewind-head">
          <h2 id={`${id}-title`}>Rewind conversation</h2>
        </header>
          {loading && <p className="rewind-empty" role="status">Loading messages...</p>}
          {!loading && !points.length && !error && <p className="rewind-empty">No messages to rewind.</p>}
          {(!points[0] || points[0].outcome !== 'cancelled' || error) && <ul ref={list} tabIndex={0} role="listbox" aria-label="Messages in this session" aria-activedescendant={selected ? `${id}-${pick}` : undefined}>
            {points.map((point, index) => <li id={`${id}-${index}`} key={point.id} role="option" aria-selected={pick === index}
              className={pick === index ? 'on' : undefined} onMouseMove={() => setPick(index)} onClick={() => { if (!busy) { setPick(index); void rewind(point) } }}>
              <div className="rewind-row"><span>{point.text.replace(/!?\[[^\]]*\]\(\s*data:image\/[^)]*(?:\)|$)/gi, '[Image]').replace(/data:image\/[^\s)]+/gi, '[Image]').trim() || '(Attachments only)'}</span><ChevronRight size={15} aria-hidden="true" /></div>
              <div className="rewind-meta">
                {point.createdAt !== undefined && <time dateTime={new Date(point.createdAt).toISOString()}>{new Date(point.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>}
                {point.threadId && <span>Thread</span>}
                {point.laterMessages !== undefined && <span>{point.laterMessages} {point.laterMessages === 1 ? 'message' : 'messages'} later</span>}
              </div>
            </li>)}
          </ul>}
        {error && <p role="alert" className="composer-error rewind-error">{error}</p>}
        {busy && <p className="rewind-empty" role="status">Rewinding...</p>}
      </div>
    </div>, document.body
  )
}
