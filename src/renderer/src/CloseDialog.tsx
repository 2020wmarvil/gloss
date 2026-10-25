import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import type { GlossEvent } from '@shared/ipc'

type Request = Extract<GlossEvent, { type: 'confirmClose' }>

/** Receives main-process close requests in either kind of Gloss window. */
export function CloseDialog(): React.JSX.Element | null {
  const [request, setRequest] = useState<Request | null>(null)
  useEffect(() => window.gloss.onEvent((event) => {
    if (event.type === 'confirmClose') setRequest(event)
  }), [])
  const dismiss = useCallback(() => setRequest(null), [])
  return request && <ClosePrompt request={request} onDismiss={dismiss} />
}

function ClosePrompt({ request, onDismiss }: { request: Request; onDismiss(): void }): React.JSX.Element {
  const keep = useRef<HTMLButtonElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const answering = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const answer = useCallback(async (approved: boolean): Promise<void> => {
    if (answering.current) return
    answering.current = true
    try {
      await window.gloss.confirmClose(request.requestId, approved)
      onDismiss()
    } catch {
      answering.current = false
      setError('Could not close Gloss. Please try again.')
    }
  }, [request.requestId, onDismiss])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    keep.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      // This confirmation takes precedence over other dialogs and app shortcuts.
      event.stopImmediatePropagation()
      if (event.key === 'Escape') {
        event.preventDefault()
        void answer(false)
      } else if (event.key === 'Tab') {
        event.preventDefault()
        const next = document.activeElement === keep.current ? close.current : keep.current
        next?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (previous?.isConnected) previous.focus()
    }
  }, [answer])

  return createPortal(
    <div className="dialog-backdrop close-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) void answer(false)
    }}>
      <div className="dialog close-dialog" role="alertdialog" aria-modal="true" aria-labelledby="close-title" aria-describedby="close-description">
        <div className="close-heading"><AlertTriangle aria-hidden="true" /><h2 id="close-title">Close Gloss?</h2></div>
        <p id="close-description">
          {request.working === 1 ? 'A session is still working.' : `${request.working} sessions are still working.`}
          {' '}Closing Gloss will stop all running sessions.
        </p>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button ref={keep} onClick={() => void answer(false)}>Keep open</button>
          <button ref={close} className="danger" onClick={() => void answer(true)}>Close Gloss</button>
        </div>
      </div>
    </div>, document.body
  )
}
