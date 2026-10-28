// The Worktrees screen (docs/mocks/worktrees.html, SPEC → Worktrees): the project folder and
// every worktree of the project, what each holds, its sessions, and where New session starts.
import { useEffect, useState } from 'react'
import { folderName, sameFolder } from '@shared/paths'
import type { Project, Session, Worktree } from '@shared/types'
import { Folder, GitBranch, GitCompare, Plus, Star, Trash2 } from 'lucide-react'

type Props = {
  project: Project
  /** Null while they are read. */
  worktrees: Worktree[] | null
  /** Gloss's sessions; each worktree shows those working in it. */
  sessions: Session[]
  running: Record<string, string | null>
  /** Where New session starts: `folder`, `worktree` or an existing worktree's path. */
  place: string
  /** The project's base branch and setup command settings, for the lede. */
  base: string
  setup: string
  error: string | null
  onSetPlace(place: string): void
  onNewSession(path: string): void
  onReview(path: string): void
  /** Removes a worktree, its branch and its sessions. */
  onRemove(path: string): Promise<void>
  onOpenSession(id: string): void
  onOpenSettings(): void
  onClose(): void
}

/** "3 uncommitted files · 2 unpushed commits · PR #61 open", or "Clean". */
function stateParts(w: Worktree): { text: string; tone: 'warn' | 'ok' | 'pr' }[] {
  if (!w.work) return []
  const parts: { text: string; tone: 'warn' | 'ok' | 'pr' }[] = []
  const { uncommitted, unpushed, pr } = w.work
  if (uncommitted) parts.push({ text: `${uncommitted} uncommitted ${uncommitted === 1 ? 'file' : 'files'}`, tone: 'warn' })
  if (unpushed && pr?.state !== 'merged') parts.push({ text: `${unpushed} unpushed ${unpushed === 1 ? 'commit' : 'commits'}`, tone: 'warn' })
  if (pr) parts.push({ text: `PR #${pr.number} ${pr.state}`, tone: 'pr' })
  if (parts.length === 0) parts.push({ text: 'Clean', tone: 'ok' })
  return parts
}

/** What removing it would lose, for the confirmation. */
function losses(w: Worktree, sessions: Session[]): string[] {
  const parts = w.work?.unfinished ? stateParts(w).filter((p) => p.tone !== 'ok').map((p) => p.text) : []
  return [...parts, ...sessions.map((s) => `Session “${s.title}”`)]
}

export function WorktreesScreen(props: Props): React.JSX.Element {
  const { project, worktrees } = props
  const [confirm, setConfirm] = useState<Worktree | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (confirm) setConfirm(null)
      else props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, props.onClose])

  const sessionsIn = (w: Worktree): Session[] => props.sessions.filter((s) => sameFolder(s.cwd, w.path))

  async function remove(w: Worktree): Promise<void> {
    setConfirm(null)
    setRemoving(w.path)
    try {
      await props.onRemove(w.path)
    } finally {
      setRemoving(null)
    }
  }

  const row = (w: Worktree): React.JSX.Element => {
    const place = w.main ? 'folder' : w.path
    const starred = props.place === place
    const inIt = sessionsIn(w)
    return (
      <div className="worktree" key={w.path}>
        <div className="worktree-main">
          <div className="worktree-branch">
            {w.main ? <Folder aria-hidden /> : <GitBranch aria-hidden />}
            <span className="mono">{w.branch ?? 'detached HEAD'}</span>
            <button
              className={starred ? 'icon-button worktree-star on' : 'icon-button worktree-star'}
              aria-pressed={starred}
              aria-label={starred ? 'New session starts here' : 'Make this where New session starts'}
              title={starred ? 'New session starts here' : 'Make this where New session starts'}
              onClick={() => props.onSetPlace(starred && !w.main ? 'folder' : place)}
            >
              <Star fill={starred ? 'currentColor' : 'none'} />
            </button>
          </div>
          <div className="worktree-path mono" title={w.path}>{w.path}</div>
        </div>
        <div className="worktree-actions">
          <button className="secondary sm" onClick={() => props.onNewSession(w.path)} title="New session here with the default agent">
            <Plus />
            New session
          </button>
          <button className="ghost sm" onClick={() => props.onReview(w.path)} title="Review this folder's changes">
            <GitCompare />
            Review
          </button>
        </div>
        <div className="worktree-sessions">
          {inIt.length > 0
            ? inIt.map((s) => (
                <button key={s.id} className="worktree-chip" onClick={() => props.onOpenSession(s.id)} title={s.title}>
                  {s.id in props.running && <span className="running-dot" aria-label="Running" />}
                  <span className="worktree-chip-title">{s.title}</span>
                </button>
              ))
            : !w.main && (
                <span className="worktree-none">{w.work?.unfinished ? 'No sessions. Its work is kept until you remove it.' : 'No sessions.'}</span>
              )}
          {!w.main && (
            <button
              className="icon-button worktree-remove"
              disabled={removing === w.path}
              onClick={() => (losses(w, inIt).length > 0 ? setConfirm(w) : void remove(w))}
              title={removing === w.path ? 'Removing…' : 'Remove the worktree, its branch and its sessions'}
              aria-label={`Remove ${w.branch ?? folderName(w.path)}`}
            >
              <Trash2 />
            </button>
          )}
        </div>
      </div>
    )
  }

  const main = worktrees?.find((w) => w.main)
  const others = worktrees?.filter((w) => !w.main) ?? []
  return (
    <main className="worktrees-screen">
      <div className="worktrees-body">
        <div>
        <div className="worktrees-top">
          <h2>Worktrees</h2>
          <button className="secondary" onClick={props.onClose} title="Close (Esc)">Done</button>
        </div>
        <p className="lede">
          New worktrees branch from {props.base ? <code>{props.base}</code> : 'the project folder’s branch'}
          {props.setup ? <> and run <code>{props.setup}</code></> : ''}.
          <br />
          <button className="link-button" onClick={props.onOpenSettings}>Configure in Settings</button>
        </p>
        {props.error && <p className="settings-problem">{props.error}</p>}
        {worktrees === null ? (
          <p className="lede">Reading the worktrees…</p>
        ) : worktrees.length === 0 ? (
          <p className="lede">{folderName(project.path)} isn&apos;t a git repository, so it has no worktrees.</p>
        ) : (
          <>
            <div className="worktrees-label">Project folder</div>
            <div className="settings-card">{main && row(main)}</div>
            <div className="worktrees-label">Worktrees · {others.length}</div>
            <div className="settings-card">
              {others.length > 0 ? others.map(row) : <p className="worktree-none padded">None yet. Start one from New session ▾ → New worktree.</p>}
            </div>
          </>
        )}
        </div>
      </div>
      {confirm && (
        <div className="dialog-backdrop">
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="remove-worktree-title">
            <h2 id="remove-worktree-title">Remove {confirm.branch ?? folderName(confirm.path)}?</h2>
            <p className="muted">
              This deletes the folder and the branch
              {sessionsIn(confirm).length > 0 ? ', and the sessions working there (the agent’s copies too)' : ''}. It can&apos;t be undone:
            </p>
            <ul className="worktree-losses">
              {losses(confirm, sessionsIn(confirm)).map((l) => <li key={l}>{l}</li>)}
            </ul>
            <div className="dialog-actions">
              <button className="ghost" onClick={() => setConfirm(null)} autoFocus>
                Keep it
              </button>
              <button className="danger" onClick={() => void remove(confirm)}>
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
