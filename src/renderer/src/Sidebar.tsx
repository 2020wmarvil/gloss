import { modKey } from './shortcuts'
// The sidebar (docs/mocks/target.html): a project switcher and one list of
// the project's sessions, Gloss's and the agent's own (SPEC → Projects and sessions).
import { useEffect, useRef, useState } from 'react'
import { sameFolder } from '@shared/paths'
import { projectOf } from '@shared/worktree'
import type { SessionOrder } from '@shared/settings'
import type { AgentInfo, AgentSession, Project, RateLimit, Session } from '@shared/types'
import { formatReset } from './StatusLine'
import { AppWindow, ChevronDown, ChevronRight, ChevronsUpDown, CircleAlert, Ellipsis, Folder, FolderGit2, GitBranch, GitCompare, Info, List, PanelLeft, Plus, Search, Settings, Star, X } from 'lucide-react'
import { folderName } from '@shared/paths'

type Props = {
  agents: AgentInfo[]
  /** The starred agent: new sessions use it unless another is picked from the menu. */
  defaultAgent: string
  onSetDefaultAgent(id: string): void
  /** Each agent's plan limits as far as known: a reached one shows in the ▾ menu. */
  rateLimits: Record<string, RateLimit[]>
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
  /** Starts a session with the given agent and place, or the defaults (SPEC → Worktrees). */
  onNew(agentId?: string, place?: string): void
  /** Where New session starts in this project: `folder`, `worktree` (a new one) or an existing worktree's path. */
  place: string
  /** The branch of the starred existing worktree, for its row. */
  placeBranch?: string | null
  /** Stars a place: New session starts there. */
  onSetPlace(place: string): void
  /** Opens the Worktrees screen. */
  onWorktrees(): void
  worktreesOpen: boolean
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
  /** What the ▾ menu will start: picked rows, starting on the defaults each time it opens. */
  const [pickPlace, setPickPlace] = useState(props.place)
  const [pickAgent, setPickAgent] = useState(props.defaultAgent)
  const agentMenu = useRef<HTMLDivElement>(null)
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

  // The menu opens on the defaults (picked by the button that opens it), with Start focused, so Enter does what New session does.
  useEffect(() => {
    if (agentMenuOpen) agentMenu.current?.querySelector<HTMLButtonElement>('.new-start button')?.focus()
  }, [agentMenuOpen])

  /** In the ▾ menu: the arrows move between the rows of a list, Enter starts. */
  function onAgentMenuKey(e: React.KeyboardEvent): void {
    if (e.key === 'Enter' && !(e.target as HTMLElement).classList.contains('agent-star')) {
      e.preventDefault()
      start()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const group = (e.target as HTMLElement).closest('[role="radiogroup"]') ?? agentMenu.current?.querySelector('[role="radiogroup"]')
      const items = [...(group?.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]:not(:disabled)') ?? [])]
      if (!items.length) return
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      const step = e.key === 'ArrowDown' ? 1 : items.length - 1
      const next = items[at === -1 ? 0 : (at + step) % items.length]
      next.focus()
      next.click()
    }
  }

  function start(): void {
    setAgentMenuOpen(false)
    props.onNew(pickAgent, pickPlace)
  }

  const existing = props.place !== 'folder' && props.place !== 'worktree' ? props.place : null
  /** A place's shortcuts with the default agent: Ctrl+N for the starred place, Ctrl+Shift+N for a new worktree. */
  const keysFor = (place: string): string => {
    const keys = [...(place === props.place ? [`${modKey()}+N`] : []), ...(place === 'worktree' ? [`${modKey()}+Shift+N`] : [])]
    return keys.length ? ` (${keys.join(', ')})` : ''
  }
  const placeName = (place: string): string =>
    place === 'folder' ? 'the project folder' : place === 'worktree' ? 'a new worktree' : (props.placeBranch ?? folderName(place))

  /** "Limit · 3:40 PM" on an agent whose plan limit is reached, until the window resets. */
  const limitNote = (agentId: string): React.JSX.Element | null => {
    const reached = (props.rateLimits[agentId] ?? []).filter((l) => l.status === 'rejected')
    if (!reached.length) return null
    // Usable again once every reached window has reset.
    const resets = reached.every((l) => l.resetsAt !== undefined) ? Math.max(...reached.map((l) => l.resetsAt ?? 0)) : null
    const at = resets === null ? null : formatReset(resets)
    return (
      <span className="agent-limit" title={`Plan limit reached${at ? `; resets ${at}` : ''}`}>
        {at ? `Limit · ${at}` : 'Limit reached'}
      </span>
    )
  }

  const agentName = (id: string): string => props.agents.find((a) => a.id === id)?.name ?? id
  const defaultName = agentName(props.defaultAgent)
  const sessions = project ? props.sessions.filter((s) => sameFolder(projectOf(s), project.path)) : []
  const projectBadges = (p: Project): React.JSX.Element => {
    const list = props.sessions.filter((s) => sameFolder(projectOf(s), p.path))
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
                        sessions: props.sessions.filter((s) => sameFolder(projectOf(s), p.path)).length
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
            title={`New session with ${defaultName} in ${placeName(props.place)} (Ctrl+N)`}
          >
            {!props.creating && <Plus />}
            <span className="new-session-label">{props.creating ? 'Starting agent…' : 'New session'}</span>
            {/* The agent's first word ("Claude" for Claude Code) keeps the button on one line. */}
            {!props.creating && (
              <span className="new-session-agent">
                {props.place !== 'folder' && <GitBranch className="new-session-place" aria-label={placeName(props.place)} />}
                {existing && `${(props.placeBranch ?? folderName(existing)).replace(/^gloss\//, '')} · `}
                {defaultName.split(' ')[0]}
              </span>
            )}
          </button>
          <button
            className="secondary new-session-agents"
            aria-label="New session with any agent, anywhere"
            title="New session with any agent, in the project folder or a worktree (new worktree: Ctrl+Shift+N)"
            aria-haspopup="menu"
            aria-expanded={agentMenuOpen}
            disabled={props.creating}
            onClick={(e) => {
              e.stopPropagation()
              // Opens on the defaults, set before it shows so its first frame isn't the last pick.
              if (!agentMenuOpen) {
                setPickPlace(props.place)
                const usable = props.agents.find((a) => a.id === props.defaultAgent && a.available !== false) ?? props.agents.find((a) => a.available !== false)
                setPickAgent(usable?.id ?? props.defaultAgent)
              }
              setAgentMenuOpen((o) => !o)
              setSwitcherOpen(false)
              setMenuFor(null)
            }}
          >
            <ChevronDown className="caret" />
          </button>
          {agentMenuOpen && (
            <div className="menu agent-menu" role="menu" ref={agentMenu} onClick={(e) => e.stopPropagation()} onKeyDown={onAgentMenuKey}>
              <div className="menu-label">Where</div>
              <div role="radiogroup" aria-label="Where">
                {[
                  { value: 'folder', icon: <Folder />, label: 'Project folder', title: `Works in the project folder, with the other sessions there${keysFor('folder')}` },
                  { value: 'worktree', icon: <GitBranch />, label: 'New worktree', title: `Works on a new branch in its own folder, so it doesn't touch other sessions' files${keysFor('worktree')}` },
                  ...(existing ? [{ value: existing, icon: <GitBranch />, label: props.placeBranch ?? folderName(existing), title: `${existing}${keysFor(existing)}`, sub: 'existing' }] : [])
                ].map((p) => (
                  <div key={p.value} className="agent-item">
                    <button
                      role="menuitemradio"
                      aria-checked={pickPlace === p.value}
                      className={pickPlace === p.value ? 'picked' : undefined}
                      tabIndex={pickPlace === p.value ? 0 : -1}
                      title={p.title}
                      onClick={() => setPickPlace(p.value)}
                    >
                      {p.icon}
                      {p.label}
                      {'sub' in p && <small className="menu-sub">{p.sub}</small>}
                    </button>
                    <button
                      className={p.value === props.place ? 'agent-star on' : 'agent-star'}
                      role="menuitemcheckbox"
                      aria-checked={p.value === props.place}
                      aria-label={`Start new sessions in ${p.label}`}
                      tabIndex={-1}
                      title={p.value === props.place ? 'New session starts here' : 'Make default'}
                      onClick={() => props.onSetPlace(p.value === props.place && p.value !== 'folder' ? 'folder' : p.value)}
                    >
                      <Star fill={p.value === props.place ? 'currentColor' : 'none'} />
                    </button>
                  </div>
                ))}
              </div>
              <button className="menu-link" onClick={() => (setAgentMenuOpen(false), props.onWorktrees())}>
                <FolderGit2 />
                Existing worktree…
                <ChevronRight className="menu-link-end" />
              </button>
              <hr />
              <div className="menu-label">Agent</div>
              <div role="radiogroup" aria-label="Agent">
              {props.agents.map((a) => (
                <div key={a.id} className="agent-item">
                  <button
                    role="menuitemradio"
                    aria-checked={pickAgent === a.id}
                    className={pickAgent === a.id ? 'picked' : undefined}
                    tabIndex={pickAgent === a.id ? 0 : -1}
                    data-agent={a.id}
                    disabled={a.available === false}
                    title={a.setupMessage}
                    onClick={() => setPickAgent(a.id)}
                  >
                    {a.name}
                    {a.available === false && <small> (set up in Settings)</small>}
                    {limitNote(a.id)}
                  </button>
                  <button
                    className={a.id === props.defaultAgent ? 'agent-star on' : 'agent-star'}
                    role="menuitemradio"
                    aria-checked={a.id === props.defaultAgent}
                    aria-label={`Make ${a.name} the default agent`}
                    tabIndex={-1}
                    disabled={a.available === false}
                    title={a.id === props.defaultAgent ? 'Default agent' : 'Make default'}
                    onClick={() => props.onSetDefaultAgent(a.id)}
                  >
                    <Star fill={a.id === props.defaultAgent ? 'currentColor' : 'none'} />
                  </button>
                </div>
              ))}
              </div>
              <div className="new-start">
                <button className="primary" onClick={start} disabled={props.agents.find((a) => a.id === pickAgent)?.available === false}>
                  Start in {placeName(pickPlace)}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <button className="secondary new-session" onClick={props.onOpenProject}>
          <Plus />
          Open project…
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
        {project && (
          <button className={props.worktreesOpen ? 'ghost settings-button on' : 'ghost settings-button'} onClick={props.onWorktrees} title="Worktrees">
            <FolderGit2 />
            Worktrees
          </button>
        )}
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
