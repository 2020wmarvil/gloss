import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { errorText } from './errors'

/**
 * New project (SPEC → Projects and sessions): a name, made as a folder in the projects folder
 * with `git init`, then opened. The main process checks the name.
 */
export function NewProjectDialog({ onClose, onCreated }: { onClose(): void; onCreated(project: Project): void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void window.gloss.projects.folder().then((f) => live && setFolder(f), () => {})
    return () => {
      live = false
    }
  }, [])

  async function create(): Promise<void> {
    if (busy || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await window.gloss.projects.create(name.trim()))
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <form
        className="dialog new-project-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onSubmit={(e) => { e.preventDefault(); void create() }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose() }
        }}
      >
        <h2 id="new-project-title">New project</h2>
        <p className="muted">{folder ? <>A new Git repository in <span className="new-project-folder" title={folder}>{folder}</span>.</> : 'A new Git repository in your projects folder.'} Change the folder in Settings.</p>
        <input className="setting-text" aria-label="Project name" placeholder="Project name" value={name} disabled={busy} autoFocus
          onChange={(e) => setName(e.target.value)} />
        {error && <p role="alert" className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
