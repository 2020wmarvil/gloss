// The annotation canvas in its own window (SPEC → Visual feedback → Annotation canvas), so the
// session it is for stays in view and usable. The window that asked gets the result.
import { useEffect, useState } from 'react'
import type { AnnotateRequest } from '@shared/capture'
import type { ThemeSetting } from '@shared/settings'
import { AnnotateDialog } from './AnnotateDialog'
import { TitleBar } from './Brand'
import { errorText } from './errors'
import { applyTheme } from './theme'

export function AnnotateWindow(): React.JSX.Element {
  const [request, setRequest] = useState<AnnotateRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [theme, setTheme] = useState<ThemeSetting>('system')

  useEffect(() => {
    document.title = 'Annotate · Gloss'
    void window.gloss.settings.get().then((s) => setTheme(s.global.theme))
    void window.gloss.annotate
      .initial()
      .then((r) => (r ? setRequest(r) : setError('Nothing to annotate.')))
      .catch((err: unknown) => setError(errorText(err)))
    return window.gloss.onEvent((event) => {
      if (event.type === 'settings') setTheme(event.state.global.theme)
    })
  }, [])

  useEffect(() => applyTheme(theme), [theme])

  return (
    <div className="app annotate-window">
      <TitleBar />
      {request ? (
        <AnnotateDialog
          initial={request.annotation}
          onRetake={request.retake ? () => window.gloss.capture.start() : undefined}
          onCancel={() => void window.gloss.annotate.finish(null)}
          onAdd={(image, annotation) => void window.gloss.annotate.finish({ image, annotation })}
        />
      ) : (
        <main className="empty-state">{error && <p role="alert">{error}</p>}</main>
      )}
    </div>
  )
}
