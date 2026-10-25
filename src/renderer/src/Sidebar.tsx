import { modKey } from './shortcuts'
// The sidebar (docs/mocks/target.html): a project switcher and one list of
// the project's sessions, Gloss's and the agent's own (SPEC → Projects and sessions).
import { useEffect, useRef, useState } from 'react'
import { sameFolder } from '@shared/paths'
import type { SessionOrder } from '@shared/settings'
import type { AgentInfo, AgentSession, Project, Session } from '@shared/types'
import { AppWindow, ChevronDown, ChevronsUpDown, CircleAlert, Ellipsis, GitCompare, Info, List, PanelLeft, Plus, Search, Settings, Star, X } from 'lucide-react'

type Props = {
  agents: AgentInfo[]
  /** The starred agent: new sessions use it unless another is picked from the menu. */
  defaultAgent: string
  onSetDefaultAgent(id: string): void
  /** Width the user dragged it to; null = the CSS default. */
  width: number | null
  projects: Project[]
  project: Project | null
  /** All Gloss sessions; the sidebar shows the current project's. */
  sessions: Session[]
  openId: string | null
  /** Sessions open in their own windows (SPEC → Session windows); clicking one brings its window forward. */
  popped?: string[]
  running: Record<string, string | null>
  /** Sessions whose last turn finished or failed while the user wasn't looking. */
  unseen: Record<string, 'completed' | 'failed'>
  /** Sessions whose agent is waiting on the user (a question or an approval). */
  waiting?: Record<string, unknown[]>
  /** The agents' sessions in the project that Gloss has no record of; null while loading. */
  agentSessions: ListedAgentSession[] | null
  /** Newest first, or most recent activity first (the `sessionOrder` setting). */
  order: SessionOrder
  agentSessionsError: string | null
  /** The agent session being imported. */
  importing: string | null
  creating: boolean
  note: SidebarNote | null
  onDismissNote(): void
  settingsOpen: boolean
  /** settings.json's last edit was rejected. */
  settingsError: boolean
  onSelectProject(path: string): void
  onOpenProject(): void
  onDeleteProject(path: string): void
  onSelect(id: string): void
  /** Starts a session with the given agent, or the default one. */
  onNew(agentId?: string): void
  /** Starts a review of the project's branch with the default agent (SPEC → Review sessions). */
  onReview(): void
  onImport(session: ListedAgentSession): void
  onRename(id: string, title: string): void
  onDelete(id: string): void
  onCopyMarkdown(id: string): void
  /** Opens a session in its own window. */
  onPopOut?(id: string): void
  onSaveMarkdown(id: string): void
  onSearch(): void
  /** Collapses the sidebar to a rail. */
  onCollapse(): void
  onSettings(): void
}

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

/** Marks review sessions and the button that starts one. */
const reviewIcon = <GitCompare className="review-icon" />

/**
 * The collapsed sidebar, like the side panel's rail: a sessions button, the project's
 * session count in its tooltip. Running sessions show on their rows, the project and the taskbar, not here.
 */
export function SidebarRail(props: { count: number; onExpand(): void }): React.JSX.Element {
  const what = `${props.count} ${props.count === 1 ? 'session' : 'sessions'}`
  return (
    <div className="side-rail sidebar-rail">
      <button className="rail-button" onClick={props.onExpand} title={`Show sidebar (${what})`} aria-label={`Show sidebar, ${what}`}>
        <List />
      </button>
    </div>
  )
}

/** One of an agent's own sessions, with the agent it belongs to. */
export type ListedAgentSession = AgentSession & { agentId: string }

/** A message over the session list: something that failed, or (`info`) news. */
export type SidebarNote = { text: string; tone: 'failed' | 'info' }

type Row =
  | { kind: 'gloss'; session: Session; at: number }
  | { kind: 'agent'; agent: ListedAgentSession; at: number }

export function Sidebar(props: Props): React.JSX.Element {
  const { project, openId, running, agentSessions } = props
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ project: Project; sessions: number } | null>(null)
  // Clicks elsewhere and Escape close the menus.
  useEffect(() => {
    if (!switcherOpen && !agentMenuOpen && menuFor === null) return
    const close = (): void => {
      setSwitcherOpen(false)
      setAgentMenuOpen(false)
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
  }, [switcherOpen, agentMenuOpen, menuFor])

  const agentName = (id: string): string => props.agents.find((a) => a.id === id)?.name ?? id
  const defaultName = agentName(props.defaultAgent)
  const sessions = project ? props.sessions.filter((s) => sameFolder(s.cwd, project.path)) : []
  const projectBadges = (p: Project): React.JSX.Element => {
    const list = props.sessions.filter((s) => sameFolder(s.cwd, p.path))
    const waiting = list.some((s) => (props.waiting?.[s.id]?.length ?? 0) > 0)
    const working = list.some((s) => s.id in running)
    const failed = list.some((s) => props.unseen[s.id] === 'failed')
    const completed = list.some((s) => props.unseen[s.id] === 'completed')
    return <span className="project-badges">
      {waiting && <span className="project-badge" title="Waiting" role="img" aria-label="Waiting"><span className="waiting-dot" aria-hidden /></span>}
      {working && <span className="project-badge" title="Working" role="img" aria-label="Working"><span className="running-dot" aria-hidden /></span>}
      {failed && <span className="project-badge" title="Failed" role="img" aria-label="Failed"><span className="failed-dot" aria-hidden /></span>}
      {completed && <span className="project-badge" title="Completed" role="img" aria-label="Completed"><span className="done-dot" aria-hidden /></span>}
    </span>
  }
  // Gloss's sessions and the agent's own, newest or most recently active first. The
  // agent doesn't say when its own sessions began, so they go by their last activity.
  const rows: Row[] = [
    ...sessions.map(
      (session): Row => ({
        kind: 'gloss',
        session,
        at: props.order === 'activity' ? (session.activeAt ?? session.createdAt) : session.createdAt
      })
    ),
    ...(agentSessions ?? []).map((agent): Row => ({
      kind: 'agent',
      agent,
      at: agent.updatedAt ? Date.parse(agent.updatedAt) || 0 : 0
    }))
  ].sort((a, b) => b.at - a.at)

  const sessionRow = (s: Session, at: number): React.JSX.Element =>
    renaming === s.id ? (
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
          setAgentMenuOpen(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onSelect(s.id)
          if (e.key === 'F2') setRenaming(s.id)
        }}
      >
        {/* One lead slot: running, else an unseen failure or finish, else the review icon. One trail slot: the time, and … on hover. */}
        <span className="row-lead">
          {(props.waiting?.[s.id]?.length ?? 0) > 0 ? (
            <span className="waiting-dot" aria-label="Waiting for you" title="Waiting for you" />
          ) : s.id in running ? (
            <span className="running-dot" aria-label="Running" />
          ) : props.unseen[s.id] === 'failed' ? (
            <span className="failed-dot" aria-label="The last turn failed" title="The last turn failed" />
          ) : props.unseen[s.id] === 'completed' ? (
            <span className="done-dot" aria-label="Finished" title="Finished since you last looked" />
          ) : (
            s.review && reviewIcon
          )}
        </span>
        <span className="session-title" onDoubleClick={() => setRenaming(s.id)}>
          {s.title}
          {props.popped?.includes(s.id) && (
            <AppWindow className="popped-icon" aria-label="In its own window" />
          )}
          <small className="session-agent">
            {agentName(s.agentId)}
            {s.review && (s.openThreads ?? 0) > 0 && ` · ${s.openThreads} open`}
          </small>
        </span>
        <span className="when">{ago(at)}</span>
        <button
          className="icon-button row-more"
          aria-label="Session actions"
          title="Rename, export or delete"
          onClick={(e) => {
            e.stopPropagation()
            setMenuFor(menuFor === s.id ? null : s.id)
            setSwitcherOpen(false)
            setAgentMenuOpen(false)
          }}
        >
          <Ellipsis />
        </button>
        {menuFor === s.id && (
          <div className="menu row-actions" role="menu" onClick={(e) => e.stopPropagation()}>
            <button role="menuitem" onClick={() => (setMenuFor(null), setRenaming(s.id))}>
              Rename
            </button>
            {props.onPopOut && !props.popped?.includes(s.id) && (
              <button role="menuitem" onClick={() => (setMenuFor(null), props.onPopOut?.(s.id))}>
                Open in new window
              </button>
            )}
            <button role="menuitem" onClick={() => (setMenuFor(null), props.onCopyMarkdown(s.id))}>
              Copy as markdown
            </button>
            <button role="menuitem" onClick={() => (setMenuFor(null), props.onSaveMarkdown(s.id))}>
              Save as markdown…
            </button>
            <button
              role="menuitem"
              className="danger"
              onClick={() => (setMenuFor(null), props.onDelete(s.id))}
            >
              Delete
            </button>
          </div>
        )}
      </div>
    )

  return (
    <nav className="sidebar" style={props.width === null ? undefined : { flexBasis: props.width }}>
      <div className="sidebar-top">
        <div className="switcher">
          <button
            className="switch-button"
            title={project?.path}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            onClick={(e) => {
              e.stopPropagation()
              setSwitcherOpen((o) => !o)
              setAgentMenuOpen(false)
              setMenuFor(null)
            }}
          >
            <span className="switch-names">
              <b>{project?.name ?? 'No project'}</b>
              <span className="switch-where">{project ? project.where : 'Open a folder to start'}</span>
            </span>
            <ChevronsUpDown className="caret" />
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
                      {projectBadges(p)}
                    </b>
                    <span className="project-where" title={p.path}>
                      {p.where}
                    </span>
                  </button>
                  <button
                    className="project-delete"
                    aria-label={`Delete ${p.name}`}
                    title="Delete project"
                    onClick={(e) => {
                      e.stopPropagation()
                      setConfirmDelete({
                        project: p,
                        sessions: props.sessions.filter((s) => sameFolder(s.cwd, p.path)).length
                      })
                    }}
                  >
                    <X />
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
        <button className="icon-button sidebar-collapse" onClick={props.onCollapse} aria-label="Hide sidebar" title="Hide sidebar">
          <PanelLeft />
        </button>
      </div>

      {project ? (
        <div className="new-session-split">
          <button
            className="secondary new-session"
            onClick={() => props.onNew()}
            disabled={props.creating || props.agents.find((a) => a.id === props.defaultAgent)?.available === false}
            title={`New session with ${defaultName} (Ctrl+N)`}
          >
            {!props.creating && <Plus />}
            <span className="new-session-label">{props.creating ? 'Starting agent…' : 'New session'}</span>
            {/* The agent's first word ("Claude" for Claude Code) keeps the button on one line. */}
            {!props.creating && <span className="new-session-agent">{defaultName.split(' ')[0]}</span>}
          </button>
          <button
            className="secondary new-session-agents"
            aria-label="New session with another agent"
            aria-haspopup="menu"
            aria-expanded={agentMenuOpen}
            disabled={props.creating}
            onClick={(e) => {
              e.stopPropagation()
              setAgentMenuOpen((o) => !o)
              setSwitcherOpen(false)
              setMenuFor(null)
            }}
          >
            <ChevronDown className="caret" />
          </button>
          {agentMenuOpen && (
            <div className="menu agent-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              {props.agents.map((a) => (
                <div key={a.id} className="agent-item">
                  <button role="menuitem" disabled={a.available === false} title={a.setupMessage} onClick={() => (setAgentMenuOpen(false), props.onNew(a.id))}>
                    {a.name}
                    {a.available === false && <small> (set up in Settings)</small>}
                  </button>
                  <button
                    className={a.id === props.defaultAgent ? 'agent-star on' : 'agent-star'}
                    role="menuitemradio"
                    aria-checked={a.id === props.defaultAgent}
                    aria-label={`Make ${a.name} the default agent`}
                    disabled={a.available === false}
                    title={a.id === props.defaultAgent ? 'Default agent' : 'Make default'}
                    onClick={() => props.onSetDefaultAgent(a.id)}
                  >
                    <Star fill={a.id === props.defaultAgent ? 'currentColor' : 'none'} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <button className="secondary new-session" onClick={props.onOpenProject}>
          <Plus />
          Open project…
        </button>
      )}
      {project && (
        <button
          className="ghost review-changes"
          onClick={props.onReview}
          disabled={props.creating || props.agents.find((a) => a.id === props.defaultAgent)?.available === false}
          title="View this branch's changes: its pull request's, else everything since it left the default branch, committed or not"
        >
          {reviewIcon}
          View changes
        </button>
      )}
      {props.note && (
        <div className={`sidebar-note ${props.note.tone}`} role={props.note.tone === 'failed' ? 'alert' : 'status'}>
          {props.note.tone === 'failed' ? <CircleAlert className="sidebar-note-icon" aria-hidden /> : <Info className="sidebar-note-icon" aria-hidden />}
          <p>{props.note.text}</p>
          <button className="icon-button" aria-label="Dismiss" title="Dismiss" onClick={props.onDismissNote}>
            <X />
          </button>
        </div>
      )}

      <div className="sidebar-scroll">
        {project && (
          <>
            <div className="label">Sessions</div>
            <ul className="session-list">
              {rows.length === 0 && <li className="sidebar-empty">No sessions yet</li>}
              {rows.map((row) =>
                row.kind === 'agent' ? (
                  <li key={`${row.agent.agentId}:${row.agent.acpSessionId}`}>
                    <button
                      className="session-row agent"
                      title={`${row.agent.title}\nStarted outside Gloss: open it here`}
                      disabled={props.importing !== null}
                      onClick={() => props.onImport(row.agent)}
                    >
                      <span className="row-lead" aria-hidden>
                        <span className="agent-ring" />
                      </span>
                      <span className="session-title">
                        {row.agent.title}
                        <small className="session-agent">{agentName(row.agent.agentId)}</small>
                      </span>
                      <span className="when">
                        {props.importing === row.agent.acpSessionId ? 'Opening…' : row.at ? ago(row.at) : ''}
                      </span>
                    </button>
                  </li>
                ) : (
                  <li key={row.session.id}>{sessionRow(row.session, row.at)}</li>
                )
              )}
              {props.agentSessionsError && <li className="sidebar-error">{props.agentSessionsError}</li>}
            </ul>
          </>
        )}
      </div>

      <div className="sidebar-foot">
        <button className="ghost settings-button" onClick={props.onSearch} title={`Search conversations (${modKey()}+Shift+F)`}>
          <Search />
          Search
        </button>
        <button
          className={props.settingsOpen ? 'ghost settings-button on' : 'ghost settings-button'}
          onClick={props.onSettings}
          title="Settings (Ctrl+,)"
        >
          <Settings />
          Settings
          {props.settingsError && (
            <span className="settings-alert" title="settings.json has a problem">
              !
            </span>
          )}
        </button>
      </div>

      {confirmDelete && (
        <div className="dialog-backdrop">
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">Delete “{confirmDelete.project.name}”?</h2>
            <p className="muted">
              This removes the project from Gloss and deletes{' '}
              {confirmDelete.sessions === 0
                ? 'nothing else: none of its sessions were opened in Gloss'
                : confirmDelete.sessions === 1
                  ? "its session, with its messages, threads and the agent's own copy"
                  : `its ${confirmDelete.sessions} sessions, with their messages, threads and the agent's own copies`}
              . The agent&apos;s sessions that were never opened in Gloss are kept, and the folder&apos;s files are not
              touched. It can&apos;t be undone.
            </p>
            <div className="dialog-actions">
              <button className="ghost" onClick={() => setConfirmDelete(null)} autoFocus>
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => {
                  props.onDeleteProject(confirmDelete.project.path)
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
