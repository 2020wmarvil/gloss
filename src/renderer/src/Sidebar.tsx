// The sidebar (docs/mocks/sidebar-switcher.html): a project switcher, the project's
// Gloss sessions, then the agent's sessions in that folder not yet in Gloss.
import { useEffect, useRef, useState } from 'react'
import { sameFolder } from '@shared/paths'
import type { AgentSession, Project, Session } from '@shared/types'

type Props = {
  /** Width the user dragged it to; null = the CSS default. */
  width: number | null
  projects: Project[]
  project: Project | null
  /** All Gloss sessions; the sidebar shows the current project's. */
  sessions: Session[]
  openId: string | null
  running: Record<string, string | null>
  /** The agent's sessions in the project not yet in Gloss; null while loading. */
  agentSessions: AgentSession[] | null
  agentSessionsError: string | null
  /** The agent session being imported. */
  importing: string | null
  creating: boolean
  createError: string | null
  settingsOpen: boolean
  /** settings.json's last edit was rejected. */
  settingsError: boolean
  onSelectProject(path: string): void
  onOpenProject(): void
  onDeleteProject(path: string): void
  onSelect(id: string): void
  onNew(): void
  onImport(session: AgentSession): void
  onRename(id: string, title: string): void
  onDelete(id: string): void
  onCopyMarkdown(id: string): void
  onSaveMarkdown(id: string): void
  onSettings(): void
}

const AGENT_SESSIONS_SHOWN = 5

/** "now", "5m", "3h", "2d", "3w", "4mo". */
export function ago(time: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - time) / 60_000))
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  if (d < 30) return `${Math.round(d / 7)}w`
  return `${Math.round(d / 30)}mo`
}

export function Sidebar(props: Props): React.JSX.Element {
  const { project, openId, running, agentSessions } = props
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'session'; session: Session } | { kind: 'project'; project: Project; sessions: number } | null
  >(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => setShowAll(false), [project?.path])

  // Clicks elsewhere and Escape close the menus.
  useEffect(() => {
    if (!switcherOpen && menuFor === null) return
    const close = (): void => {
      setSwitcherOpen(false)
      setMenuFor(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [switcherOpen, menuFor])

  const sessions = project ? props.sessions.filter((s) => sameFolder(s.cwd, project.path)) : []
  const isRunningIn = (p: Project): boolean =>
    props.sessions.some((s) => s.id in running && sameFolder(s.cwd, p.path))
  const shownAgent = agentSessions && (showAll ? agentSessions : agentSessions.slice(0, AGENT_SESSIONS_SHOWN))

  return (
    <nav className="sidebar" style={props.width === null ? undefined : { flexBasis: props.width }}>
      <div className="brand">gloss.</div>

      <div className="switcher">
        <button
          className="switch-button"
          aria-haspopup="menu"
          aria-expanded={switcherOpen}
          onClick={(e) => {
            e.stopPropagation()
            setSwitcherOpen((o) => !o)
            setMenuFor(null)
          }}
        >
          <span className="switch-names">
            <b>{project?.name ?? 'No project'}</b>
            {project && <span className="mono">{project.path}</span>}
          </span>
          <span className="caret" aria-hidden>
            ▾
          </span>
        </button>
        {switcherOpen && (
          <div className="menu project-menu" role="menu">
            {props.projects.map((p) => (
              <div key={p.path} className="project-item">
                <button
                  role="menuitem"
                  className={project && sameFolder(p.path, project.path) ? 'on' : undefined}
                  onClick={() => props.onSelectProject(p.path)}
                >
                  <b>
                    {p.name}
                    {(!project || !sameFolder(p.path, project.path)) && isRunningIn(p) && (
                      <span className="running-dot" aria-label="Running" />
                    )}
                  </b>
                  <span className="mono">{p.path}</span>
                </button>
                <button
                  className="project-delete"
                  aria-label={`Delete ${p.name}`}
                  title="Delete project"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmDelete({
                      kind: 'project',
                      project: p,
                      sessions: props.sessions.filter((s) => sameFolder(s.cwd, p.path)).length
                    })
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            {props.projects.length > 0 && <hr />}
            <button role="menuitem" onClick={props.onOpenProject}>
              Open project…
            </button>
          </div>
        )}
      </div>

      {project ? (
        <button className="new-session" onClick={props.onNew} disabled={props.creating} title="New session (Ctrl+N)">
          {props.creating ? 'Starting agent…' : '+ New session'}
        </button>
      ) : (
        <button className="new-session" onClick={props.onOpenProject}>
          Open project…
        </button>
      )}
      {props.createError && <p className="sidebar-error">{props.createError}</p>}

      <div className="sidebar-scroll">
        {project && (
          <>
            <div className="label">Sessions</div>
            <ul className="session-list">
              {sessions.length === 0 && <li className="sidebar-empty">No Gloss sessions yet</li>}
              {sessions.map((s) => (
                <li key={s.id}>
                  {renaming === s.id ? (
                    <RenameInput
                      title={s.title}
                      onDone={(title) => {
                        setRenaming(null)
                        if (title !== null && title !== s.title) props.onRename(s.id, title)
                      }}
                    />
                  ) : (
                    <div
                      className={`session-row${s.id === openId ? ' on' : ''}`}
                      role="button"
                      tabIndex={0}
                      title={s.title}
                      onClick={() => props.onSelect(s.id)}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setMenuFor(s.id)
                        setSwitcherOpen(false)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') props.onSelect(s.id)
                        if (e.key === 'F2') setRenaming(s.id)
                      }}
                    >
                      <span className="session-title" onDoubleClick={() => setRenaming(s.id)}>
                        {s.title}
                      </span>
                      {s.id in running ? (
                        <span className="running-dot" aria-label="Running" />
                      ) : (
                        <span className="when">{ago(s.createdAt)}</span>
                      )}
                      {menuFor === s.id && (
                        <div className="menu row-actions" role="menu" onClick={(e) => e.stopPropagation()}>
                          <button role="menuitem" onClick={() => (setMenuFor(null), setRenaming(s.id))}>
                            Rename
                          </button>
                          <button role="menuitem" onClick={() => (setMenuFor(null), props.onCopyMarkdown(s.id))}>
                            Copy as markdown
                          </button>
                          <button role="menuitem" onClick={() => (setMenuFor(null), props.onSaveMarkdown(s.id))}>
                            Save as markdown…
                          </button>
                          <button
                            role="menuitem"
                            className="danger"
                            onClick={() => (setMenuFor(null), setConfirmDelete({ kind: 'session', session: s }))}
                          >
                            Delete…
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>

            {(props.agentSessionsError || (shownAgent && shownAgent.length > 0)) && (
              <>
                <div className="label">Not in Gloss yet</div>
                <ul className="session-list">
                  {props.agentSessionsError ? (
                    <li className="sidebar-error">{props.agentSessionsError}</li>
                  ) : (
                    (shownAgent ?? []).map((a) => (
                      <li key={a.acpSessionId}>
                        <button
                          className="session-row agent"
                          title={`${a.title}\nOpen in Gloss (imports its history)`}
                          disabled={props.importing !== null}
                          onClick={() => props.onImport(a)}
                        >
                          <span className="session-title">{a.title}</span>
                          <span className="when">
                            {props.importing === a.acpSessionId
                              ? 'Opening…'
                              : a.updatedAt
                                ? ago(Date.parse(a.updatedAt))
                                : ''}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                  {agentSessions && !showAll && agentSessions.length > AGENT_SESSIONS_SHOWN && (
                    <li>
                      <button className="show-more" onClick={() => setShowAll(true)}>
                        Show {agentSessions.length - AGENT_SESSIONS_SHOWN} more
                      </button>
                    </li>
                  )}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      <button
        className={props.settingsOpen ? 'settings-button on' : 'settings-button'}
        onClick={props.onSettings}
        title="Settings (Ctrl+,)"
      >
        Settings
        {props.settingsError && (
          <span className="settings-alert" title="settings.json has a problem">
            !
          </span>
        )}
      </button>

      {confirmDelete && (
        <div className="dialog-backdrop">
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">
              Delete “{confirmDelete.kind === 'session' ? confirmDelete.session.title : confirmDelete.project.name}”?
            </h2>
            {confirmDelete.kind === 'session' ? (
              <p className="muted">
                This deletes the session, its messages and threads from Gloss, and the agent&apos;s own copy of it. It
                can&apos;t be undone.
              </p>
            ) : (
              <p className="muted">
                This removes the project from Gloss and deletes{' '}
                {confirmDelete.sessions === 0
                  ? 'nothing else: it has no Gloss sessions'
                  : confirmDelete.sessions === 1
                    ? "its session, with its messages, threads and the agent's own copy"
                    : `its ${confirmDelete.sessions} sessions, with their messages, threads and the agent's own copies`}
                . The agent&apos;s sessions that were never opened in Gloss are kept, and the folder&apos;s files are not
                touched. It can&apos;t be undone.
              </p>
            )}
            <div className="dialog-actions">
              <button onClick={() => setConfirmDelete(null)} autoFocus>
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => {
                  if (confirmDelete.kind === 'session') props.onDelete(confirmDelete.session.id)
                  else props.onDeleteProject(confirmDelete.project.path)
                  setConfirmDelete(null)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </nav>
  )
}

function RenameInput({ title, onDone }: { title: string; onDone(title: string | null): void }): React.JSX.Element {
  const [value, setValue] = useState(title)
  const done = useRef(false)
  const finish = (save: boolean): void => {
    if (done.current) return
    done.current = true
    onDone(save && value.trim() ? value.trim() : null)
  }
  return (
    <input
      className="rename"
      aria-label="Session title"
      autoFocus
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}
