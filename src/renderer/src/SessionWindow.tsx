// A session popped out into its own window (SPEC → Session windows): the session's view
// alone, without the sidebar or settings.
import { useEffect, useRef, useState } from 'react'
import type { GlossEvent } from '@shared/ipc'
import { CaptureShortcut, clearDrafts } from './Composer'
import { SignInDialog } from './SignInDialog'
import { clampWidth, threadPanelDefault, threadPanelLimits, useStoredWidth, useWindowWidth } from './resize'
import { TitleBar } from './Brand'
import { useSession } from './useSession'
import { useAppData } from './useAppData'
import { FullScreenHint, SessionPane } from './SessionPane'

export function SessionWindow({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { settings, agents, sent, signIn, fullScreenHint } = useAppData()
  const s = useSession()
  const { restore, load } = s
  const [error, setError] = useState<string | null>(null)
  const windowWidth = useWindowWidth()
  const [threadStored, setThreadPanelWidth] = useStoredWidth('gloss.threadPanelWidth')

  // Opens the session as the main window showed it.
  useEffect(() => {
    void window.gloss.windows
      .initial()
      .then((initial) => (initial?.sessionId === sessionId ? restore(sessionId, initial.state) : load(sessionId)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }, [sessionId, restore, load])

  const title = s.open?.session.title
  useEffect(() => {
    document.title = title ? `${title} · Gloss` : 'Gloss'
  }, [title])

  /** Back to the main window, with what this window shows; its drafts go along. */
  function popIn(): void {
    const state = s.snapshot()
    void window.gloss.windows.popIn(state).then(() => clearDrafts(sessionId))
  }

  // A notification for this session opens its thread here.
  const revealRef = useRef<(event: GlossEvent) => void>(() => {})
  revealRef.current = (event) => {
    if (event.type !== 'reveal' || event.sessionId !== sessionId) return
    void load(sessionId, event.threadId)
  }
  useEffect(() => window.gloss.onEvent((event) => revealRef.current(event)), [])

  const open = s.open
  const side = threadPanelLimits(windowWidth, 0)
  const threadWidth = open && s.sideOpen ? clampWidth(threadStored ?? threadPanelDefault(windowWidth), side) : null
  const sideShown = threadWidth !== null

  // The session's own shortcuts work here; the rest bring the main window forward to act
  // there (SPEC → Session windows).
  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {})
  shortcuts.current = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod || e.altKey) return
    const key = e.key.toLowerCase()
    const toMain = (action: Parameters<typeof window.gloss.windows.toMain>[0]): void => {
      e.preventDefault()
      window.gloss.windows.toMain(action)
    }
    if (e.shiftKey && key === 'f') toMain({ kind: 'search' })
    else if (!e.shiftKey && key === 'n') toMain({ kind: 'newSession' })
    else if (e.key === ',') toMain({ kind: 'settings' })
    else if (e.key === 'Tab') {
      toMain({ kind: 'cycleSession', back: e.shiftKey })
    } else if (s.shortcut(e, sideShown, popIn).handled) e.preventDefault()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => shortcuts.current(e)
    // Files dropped outside the composer must not navigate the window.
    const block = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  return (
    <CaptureShortcut.Provider value={settings?.global.captureShortcut ?? ''}>
      <div className="app session-window">
        <TitleBar />
        <div className="sheet">
          {open ? (
            <SessionPane
              s={s}
              open={open}
              settings={settings}
              agents={agents}
              sent={sent}
              sideShown={sideShown}
              threadWidth={threadWidth}
              threadLimit={side}
              onResizeThread={setThreadPanelWidth}
              creating={false}
              onNewReview={(from) => window.gloss.windows.toMain({ kind: 'newReview', sessionId: from.id })}
              popped
              onWindow={popIn}
            />
          ) : (
            <main className="empty-state">{error && <p role="alert">{error}</p>}</main>
          )}
        </div>
        {fullScreenHint > 0 && <FullScreenHint key={fullScreenHint} />}
        {signIn && (
          <SignInDialog
            request={signIn}
            onSignIn={(methodId) => window.gloss.auth.signIn(signIn.agentId, methodId)}
            onDismiss={() => void window.gloss.auth.dismiss(signIn.agentId)}
          />
        )}
      </div>
    </CaptureShortcut.Provider>
  )
}
