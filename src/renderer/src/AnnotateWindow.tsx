// The annotation canvas in its own frameless window (SPEC → Visual feedback → Annotation canvas),
// so the session it is for stays in view and usable. The window that asked gets the result.
import { useEffect, useState } from 'react'
import { Copy, Minus, Square } from 'lucide-react'
import type { AnnotateRequest } from '@shared/capture'
import type { ThemeSetting } from '@shared/settings'
import { AnnotateDialog } from './AnnotateDialog'
import { errorText } from './errors'
import { applyTheme } from './theme'

export function AnnotateWindow(): React.JSX.Element {
  const [request, setRequest] = useState<AnnotateRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeSetting>('system')
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    document.title = 'Annotate · Gloss'
    void window.gloss.settings.get().then((s) => setTheme(s.global.theme))
    void window.gloss.annotate
      .initial()
      .then((r) => (r ? setRequest(r) : setError('Nothing to annotate.')))
      .catch((err: unknown) => setError(errorText(err)))
    return window.gloss.onEvent((event) => {
      if (event.type === 'settings') setTheme(event.state.global.theme)
      else if (event.type === 'annotateMaximized') setMaximized(event.maximized)
    })
  }, [])

  useEffect(() => applyTheme(theme), [theme])

  return (
    <div className="app annotate-window">
      {request ? (
        <AnnotateDialog
          initial={request.annotation}
          onRetake={request.retake ? () => window.gloss.capture.start() : undefined}
          onCancel={() => void window.gloss.annotate.finish(null)}
          onAdd={(image, annotation) => void window.gloss.annotate.finish({ image, annotation })}
          maximized={maximized}
          windowControls={
            <>
              <button className="icon-button" title="Minimize" aria-label="Minimize" onClick={() => window.gloss.annotate.minimize()}>
                <Minus />
              </button>
              <button
                className="icon-button"
                title={maximized ? 'Restore' : 'Maximize'}
                aria-label={maximized ? 'Restore' : 'Maximize'}
                onClick={() => window.gloss.annotate.toggleMaximize()}
              >
                {maximized ? <Copy size={14} /> : <Square size={13} />}
              </button>
            </>
          }
        />
      ) : (
        <main className="empty-state">{error && <p role="alert">{error}</p>}</main>
      )}
    </div>
  )
}
