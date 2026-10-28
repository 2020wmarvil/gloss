import type { SearchResult } from '@shared/search'
import { SearchDialog } from './SearchDialog'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { GlossEvent, PaneState } from '@shared/ipc'
import { sameFolder } from '@shared/paths'
import type { GlobalSettings } from '@shared/settings'
import type { AgentSession, Project, Session } from '@shared/types'
import { hideFileList } from './ReviewView'
import { CaptureShortcut, clearDrafts } from './Composer'
import { errorText } from './errors'
import { Sidebar, SidebarRail, type ListedAgentSession, type SidebarNote } from './Sidebar'
import { SettingsScreen } from './SettingsScreen'
import { SignInDialog } from './SignInDialog'
import {
  clampWidth,
  ResizeHandle,
  fitPanes,
  SIDEBAR_RAIL,
  SIDEBAR_DEFAULT,
  sidebarLimits,
  threadPanelDefault,
  threadPanelLimits,
  useStoredWidth,
  useWindowWidth
} from './resize'
import { modKey } from './shortcuts'
import { FolderOpen, Plus } from 'lucide-react'
import { BrandMark, TitleBar } from './Brand'
import { playChime } from './chime'
import { upsert, useSession } from './useSession'
import { useAppData } from './useAppData'
import { FullScreenHint, SessionPane } from './SessionPane'

export type { OpenSession, Panel } from './useSession'
export type { SignInRequest } from './useAppData'

/** A place back and forward return to: the settings screen, or a session and its open thread. */
type View = { sessionId: string; threadId: string | null } | 'settings'

function sameView(a: View | undefined, b: View): boolean {
  return a === b || (a !== undefined && a !== 'settings' && b !== 'settings' && a.sessionId === b.sessionId && a.threadId === b.threadId)
}

function agentSessionsKey(path: string, id: string): string {
  return `${path}\0${id}`
}

/** Most recent activity first, as the main process lists them. */
function byActivity(list: Session[]): Session[] {
  return list.sort((a, b) => (b.activeAt ?? b.createdAt) - (a.activeAt ?? a.createdAt) || b.createdAt - a.createdAt)
}

/** What a session popped out from the sidebar opens with: as if it were opened fresh. */
const FRESH_PANE: PaneState = { threadId: null, sideOpen: false, general: false, sideTab: 'threads', expandedFiles: [], drafts: {}, scroll: {} }

export function App(): React.JSX.Element {
  const { settings, agents, rateLimits, sent, signIn, fullScreenHint, updateSettings } = useAppData()
  const s = useSession()
  const { load, close: closeSession, openId } = s
  const [showSettings, setShowSettings] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  /** Project path and agent id → the agent's sessions there that Gloss has no record of. */
  const [agentSessions, setAgentSessions] = useState<Record<string, AgentSession[]>>({})
  const [agentSessionErrors, setAgentSessionErrors] = useState<Record<string, string | null>>({})
  const [importing, setImporting] = useState<string | null>(null)
  /** Sessions popped out into their own windows (SPEC → Session windows). */
  const [popped, setPopped] = useState<string[]>([])
  const poppedRef = useRef<string[]>([])
  /** The popped-out session whose window is focused: the user is looking at it. */
  const focusedPopped = useRef<string | null>(null)
  const setPoppedList = useCallback((list: string[]) => {
    poppedRef.current = list
    setPopped(list)
  }, [])
  /**
   * Sessions whose last turn finished or failed while the user wasn't looking (another
   * session open, or Gloss in the background), until they are looked at or run again.
   */
  const [unseen, setUnseen] = useState<Record<string, 'completed' | 'failed'>>({})
  const clearUnseen = useCallback((id: string) => {
    setUnseen((f) => {
      if (!(id in f)) return f
      const next = { ...f }
      delete next[id]
      return next
    })
  }, [])
  // The open session counts as looked at once Gloss is in front.
  useEffect(() => {
    const onFocus = (): void => {
      if (openId.current) clearUnseen(openId.current)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [clearUnseen, openId])
  // The app icon's badge: a failed turn, else a finished one, else working (SPEC → Notifications).
  const running = s.running
  useEffect(() => {
    const outcomes = Object.values(unseen)
    const state = outcomes.includes('failed')
      ? 'failed'
      : outcomes.length > 0
        ? 'completed'
        : Object.keys(running).length > 0
          ? 'working'
          : null
    window.gloss.setBadge?.({ state, unseen: outcomes.length })
  }, [unseen, running])
  const [creating, setCreating] = useState(false)
  /** A message over the session list: an error, or (`info`) news such as a session removed outside Gloss. */
  const [sidebarNote, setSidebarNote] = useState<SidebarNote | null>(null)
  const setSidebarError = useCallback((text: string | null) => setSidebarNote(text === null ? null : { text, tone: 'failed' }), [])
  const windowWidth = useWindowWidth()
  const [sidebarStored, setSidebarWidth] = useStoredWidth('gloss.sidebarWidth')
  const [threadStored, setThreadPanelWidth] = useStoredWidth('gloss.threadPanelWidth')
  /** The sidebar is collapsed to a rail; remembered across restarts. */
  const [sidebarHidden, setSidebarHidden] = useState(() => localStorage.getItem('gloss.sidebarHidden') === '1')
  const hideSidebar = (hidden: boolean): void => {
    setSidebarHidden(hidden)
    if (!hidden) s.setKeepPane('sidebar')
    if (hidden) localStorage.setItem('gloss.sidebarHidden', '1')
    else localStorage.removeItem('gloss.sidebarHidden')
  }

  /** Settings' turnEndSound, for the event handler. */
  const chimeOn = useRef(true)
  chimeOn.current = settings?.global.turnEndSound ?? true
  /** The review whose opening collapsed the sidebar, for `Ctrl+Shift+D` to bring it back. */
  const reviewHidSidebar = useRef<string | null>(null)
  /** Views visited, and the current one; `moving` while back or forward restores one. */
  const history = useRef<{ views: View[]; at: number; moving: boolean }>({ views: [], at: -1, moving: false })
  const project = projects.find((p) => projectPath !== null && sameFolder(p.path, projectPath)) ?? null
  const agent = settings ? agents.find((a) => a.id === settings.global.defaultAgent) ?? agents[0] : undefined

  const refreshProjects = useCallback(async () => setProjects(await window.gloss.projects.list()), [])
  const pendingDiscovery = useRef(new Set<string>())

  /** Lists every agent's own sessions in the project. */
  const loadAgentSessions = useCallback(
    async (path: string, only?: Set<string>) => {
      await Promise.all(
        agents.filter((a) => a.available !== false && (!only || only.has(a.id))).map(async (a) => {
          const key = agentSessionsKey(path, a.id)
          if (pendingDiscovery.current.has(key)) return
          pendingDiscovery.current.add(key)
          setAgentSessionErrors((all) => ({ ...all, [key]: null }))
          try {
            const list = await window.gloss.projects.agentSessions(path, a.id)
            setAgentSessions((all) => ({ ...all, [key]: list }))
          } catch (err) {
            setAgentSessionErrors((all) => ({ ...all, [key]: `Couldn't list ${a.name} sessions: ${errorText(err)}` }))
            setAgentSessions((all) => ({ ...all, [key]: [] }))
          } finally {
            pendingDiscovery.current.delete(key)
          }
        })
      )
    },
    [agents]
  )

  /** Opens a session (and thread), or brings its window forward when it is popped out. */
  const selectSession = useCallback(
    async (id: string, threadId: string | null = null, target?: SearchResult): Promise<void> => {
      clearUnseen(id)
      if (poppedRef.current.includes(id)) {
        await window.gloss.windows.focus(id)
        return
      }
      setShowSettings(false)
      const view = await load(id, threadId, target)
      if (view) setProjectPath(view.session.cwd)
    },
    [load, clearUnseen]
  )

  async function openSearchResult(result: SearchResult): Promise<void> {
    await selectSession(result.sessionId, result.threadId, result)
    if (openId.current !== result.sessionId) return
    if (result.threadId === null) {
      // A review's main thread is its general conversation, in the side panel.
      if (s.openReview.current) s.openGeneral()
      else s.setPanel(null)
    }
    s.setReveal({ messageId: result.kind === 'tool' ? `tool:${result.id}` : result.id, key: Date.now() })
  }

  /** Shows a project: its most recent session (not one in its own window), or none. */
  const selectProject = useCallback(
    (path: string, all: Session[]) => {
      setProjectPath(path)
      const first = all.find((x) => sameFolder(x.cwd, path) && !poppedRef.current.includes(x.id))
      if (first) {
        if (first.id !== openId.current) void selectSession(first.id)
      } else {
        closeSession()
      }
    },
    [selectSession, closeSession, openId]
  )

  /** The main window's own events: the session list, unseen work, and session windows. */
  const onEvent = useRef<(event: GlossEvent) => void>(() => {})
  onEvent.current = (event: GlossEvent) => {
    switch (event.type) {
      case 'session':
        // A draft review is listed once something is sent in it.
        if (!event.session.draft) setSessions((list) => byActivity(upsert(list, event.session)))
        break
      case 'sessionDeleted':
        setSessions((list) => list.filter((x) => x.id !== event.sessionId))
        if (event.deletedOutside) {
          setSidebarNote({ text: `“${event.deletedOutside.title}” was deleted outside Gloss, so it was removed here too.`, tone: 'info' })
        }
        break
      case 'reveal':
        void selectSession(event.sessionId, event.threadId)
        break
      case 'message': {
        const { sessionId: of, createdAt } = event.message
        if (createdAt !== undefined) {
          setSessions((list) =>
            list.some((x) => x.id === of && (x.activeAt ?? x.createdAt) < createdAt)
              ? byActivity(list.map((x) => (x.id === of ? { ...x, activeAt: createdAt } : x)))
              : list
          )
        }
        break
      }
      case 'turnStart':
        clearUnseen(event.sessionId)
        break
      case 'turnEnd': {
        // Work the user isn't watching (another session, or Gloss in the background) is
        // marked unseen and chimes. A cancel is the user's own; a queued follow-up isn't the end.
        // A session in its own focused window is being watched.
        const watched = (event.sessionId === openId.current && document.hasFocus()) || event.sessionId === focusedPopped.current
        if (!event.continues && event.stopReason !== 'cancelled' && !watched) {
          const outcome = event.error ? 'failed' : 'completed'
          setUnseen((u) => ({ ...u, [event.sessionId]: outcome }))
          if (chimeOn.current) playChime()
        }
        break
      }
      case 'windows':
        setPoppedList(event.popped)
        focusedPopped.current = event.focused
        if (event.focused) clearUnseen(event.focused)
        break
      case 'popIn':
        // Back from its window, as that window showed it.
        setShowSettings(false)
        clearUnseen(event.sessionId)
        void s.restore(event.sessionId, event.state).then((view) => {
          if (view) setProjectPath(view.session.cwd)
        })
        break
      case 'mainAction':
        runMainAction(event.action)
        break
    }
  }
  useEffect(() => window.gloss.onEvent((event) => onEvent.current(event)), [])

  useEffect(() => {
    void window.gloss.windows?.list().then((w) => {
      setPoppedList(w.popped)
      focusedPopped.current = w.focused
    })
    void Promise.all([window.gloss.projects.list(), window.gloss.sessions.list()]).then(([ps, list]) => {
      setProjects(ps)
      setSessions(list)
      if (list[0]) void selectSession(list[0].id)
      else if (ps[0]) setProjectPath(ps[0].path)
    })
  }, [selectSession, setPoppedList])

  // The agent's sessions for the shown project, listed when it is shown.
  const discovered = useRef<{ path: string | null; ids: Set<string> }>({ path: null, ids: new Set() })
  useEffect(() => {
    if (!projectPath) return
    if (discovered.current.path !== projectPath) discovered.current = { path: projectPath, ids: new Set() }
    const available = new Set(agents.filter((a) => a.available !== false).map((a) => a.id))
    const added = new Set([...available].filter((id) => !discovered.current.ids.has(id)))
    discovered.current.ids = available
    if (added.size) void loadAgentSessions(projectPath, added)
  }, [projectPath, loadAgentSessions, agents])

  // Back in the window: pick up what was done in the agent's CLI meanwhile (SPEC → Shared sessions).
  useEffect(() => {
    const onFocus = (): void => {
      if (projectPath) void loadAgentSessions(projectPath)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectPath, loadAgentSessions])

  async function newSession(agentId = agent?.id): Promise<void> {
    if (!projectPath) return openProject()
    if (!agentId) return
    setSidebarError(null)
    setCreating(true)
    try {
      const session = await window.gloss.sessions.create(projectPath, agentId)
      await selectSession(session.id)
      void refreshProjects()
    } catch (err) {
      setSidebarError(errorText(err))
    } finally {
      setCreating(false)
    }
  }

  /**
   * Opens a review of the project's branch (SPEC → Review sessions) with the given agent,
   * else the default one: the project's draft, or a new one. **New review** passes an open
   * review, for a fresh one with the same agent and range.
   */
  async function newReview(from?: Session, agentId = from?.agentId ?? agent?.id): Promise<void> {
    const cwd = from?.cwd ?? projectPath
    if (!cwd || !agentId) return
    setSidebarError(null)
    setCreating(true)
    try {
      const review = from?.review
      const session = await window.gloss.sessions.createReview(cwd, agentId, review?.baseRef, review?.headRef ?? null)
      // The project's draft, already in its own window.
      if (poppedRef.current.includes(session.id)) return void (await selectSession(session.id))
      // A new review starts with only the diff: the session list, the side panel and the
      // file list closed. Each remembers what it is set to from then on.
      hideFileList()
      // Or in its own window, with the side panel set to open on its general conversation.
      if (settings?.global.reviewWindow ?? true) return void (await popOut(session.id, { ...FRESH_PANE, general: true }))
      reviewHidSidebar.current = sidebarHidden ? null : session.id
      hideSidebar(true)
      await selectSession(session.id)
      s.setSideOpen(false)
      // The side panel opens on the general conversation, where a review runs.
      s.setGeneral(true)
    } catch (err) {
      setSidebarError(errorText(err))
    } finally {
      setCreating(false)
    }
  }

  async function openProject(): Promise<void> {
    setSidebarError(null)
    const p = await window.gloss.projects.open()
    if (!p) return
    await refreshProjects()
    selectProject(p.path, sessions)
  }

  async function importSession(a: ListedAgentSession): Promise<void> {
    if (!projectPath) return
    setSidebarError(null)
    setImporting(a.acpSessionId)
    try {
      const session = await window.gloss.sessions.import(projectPath, a.agentId, a.acpSessionId, a.title, a.updatedAt)
      const key = agentSessionsKey(projectPath, a.agentId)
      setAgentSessions((all) => ({ ...all, [key]: (all[key] ?? []).filter((x) => x.acpSessionId !== a.acpSessionId) }))
      await selectSession(session.id)
    } catch (err) {
      setSidebarError(`Couldn't open that session: ${errorText(err)}`)
      void loadAgentSessions(projectPath)
    } finally {
      setImporting(null)
    }
  }

  async function deleteSession(id: string): Promise<void> {
    setSidebarError(null)
    const deleted = sessions.find((x) => x.id === id)
    try {
      const warning = await window.gloss.sessions.delete(id)
      if (warning) setSidebarError(warning)
      // Show the next session in the project, if the deleted one was open.
      if (deleted && openId.current === null) {
        const rest = sessions.filter((x) => x.id !== id)
        selectProject(deleted.cwd, rest)
      }
    } catch (err) {
      setSidebarError(errorText(err))
    }
  }

  async function deleteProject(path: string): Promise<void> {
    setSidebarError(null)
    try {
      const warning = await window.gloss.projects.delete(path)
      if (warning) setSidebarError(warning)
      const [ps, list] = await Promise.all([window.gloss.projects.list(), window.gloss.sessions.list()])
      setProjects(ps)
      setSessions(list)
      setAgentSessions((all) => {
        const next = { ...all }
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${path}\0`)) delete next[key]
        }
        return next
      })
      // Show the next project, or nothing.
      if (ps[0]) selectProject(ps[0].path, list)
      else {
        setProjectPath(null)
        closeSession()
      }
    } catch (err) {
      setSidebarError(errorText(err))
    }
  }

  function exportMarkdown(id: string, how: 'copy' | 'save'): void {
    const done = how === 'copy' ? window.gloss.sessions.copyMarkdown(id, null) : window.gloss.sessions.saveMarkdown(id, null)
    done.catch((err: unknown) => s.addNotice(id, null, `Couldn't export: ${errorText(err)}`))
  }

  /** A view back and forward skip: a deleted session, or one in its own window. */
  function gone(v: View): boolean {
    return v !== 'settings' && (!sessions.some((x) => x.id === v.sessionId) || poppedRef.current.includes(v.sessionId))
  }

  /**
   * Pops a session out into its own window (SPEC → Session windows). The open one takes what
   * it shows along, and the main window goes back to the view before it, or the project's
   * empty state. A session that isn't open takes `fresh`.
   */
  async function popOut(id: string, fresh = FRESH_PANE): Promise<void> {
    const isOpen = openId.current === id
    try {
      await window.gloss.windows.popOut(id, isOpen ? s.snapshot() : fresh)
    } catch (err) {
      setSidebarError(errorText(err))
      return
    }
    setPoppedList(poppedRef.current.includes(id) ? poppedRef.current : [...poppedRef.current, id])
    if (!isOpen) return
    // Its drafts went with it.
    clearDrafts(id)
    await leaveSession(id)
  }

  /** Shows the last view visited that isn't this session (or the empty state), as if going back to it. */
  async function leaveSession(id: string): Promise<void> {
    const h = history.current
    let i = h.at
    while (i >= 0 && (gone(h.views[i]) || (h.views[i] !== 'settings' && (h.views[i] as { sessionId: string }).sessionId === id))) i--
    closeSession()
    const view = h.views[i]
    if (!view) return
    h.at = i
    if (view === 'settings') return setShowSettings(true)
    h.moving = true
    try {
      await selectSession(view.sessionId, view.threadId)
    } finally {
      h.moving = false
    }
  }

  /** Back (-1) or forward (1) through the views visited, skipping deleted and popped-out sessions. */
  async function go(step: -1 | 1): Promise<void> {
    const h = history.current
    let i = h.at + step
    while (h.views[i] && gone(h.views[i])) i += step
    const view = h.views[i]
    if (!view || h.moving) return
    h.at = i
    if (view === 'settings') return setShowSettings(true)
    h.moving = true
    try {
      setShowSettings(false)
      if (view.sessionId !== openId.current) await selectSession(view.sessionId, view.threadId)
      else if (view.threadId) s.openThread(view.threadId)
      else s.setPanel(null)
    } finally {
      h.moving = false
    }
  }

  /** The next or previous session in the project, skipping those in their own windows. */
  function cycleSession(back: boolean): void {
    const list = (projectPath ? sessions.filter((x) => sameFolder(x.cwd, projectPath)) : sessions).filter(
      (x) => !poppedRef.current.includes(x.id) || x.id === openId.current
    )
    if (list.length === 0) return
    const i = list.findIndex((x) => x.id === openId.current)
    const next = list[(i === -1 ? 0 : i + (back ? list.length - 1 : 1)) % list.length]
    void selectSession(next.id)
  }

  /**
   * `Ctrl+Shift+D`: a review with the default agent, or out of the open review, back to
   * where the user was, with the sidebar back if opening the review collapsed it.
   */
  async function toggleReview(): Promise<void> {
    const id = openId.current
    if (!id || showSettings || !s.openReview.current) return newReview()
    const restore = reviewHidSidebar.current === id
    reviewHidSidebar.current = null
    await leaveSession(id)
    if (restore) hideSidebar(false)
  }

  /** A shortcut pressed in a session window that acts here (SPEC → Session windows). */
  function runMainAction(action: Extract<GlossEvent, { type: 'mainAction' }>['action']): void {
    if (action.kind === 'search') setShowSearch(true)
    else if (action.kind === 'newSession') void newSession()
    else if (action.kind === 'review') void newReview()
    else if (action.kind === 'settings') setShowSettings(true)
    else if (action.kind === 'cycleSession') cycleSession(action.back)
    else {
      const from = sessions.find((x) => x.id === action.sessionId)
      if (from) void newReview(from)
    }
  }

  // Keyboard shortcuts (SPEC → Keyboard shortcuts). Esc closes panels in their own components.
  const shortcuts = useRef<(e: KeyboardEvent) => void>(() => {})
  shortcuts.current = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      setShowSearch(true)
      return
    }
    if (showSearch) return
    // Alt+Left / Alt+Right: back and forward. Not in a text field on macOS, where Option+arrow moves by word.
    if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const editable = e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.matches('input, textarea'))
      if (editable && modKey() === 'Cmd') return
      e.preventDefault()
      void go(e.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (!mod) return
    if (e.key === ',') {
      e.preventDefault()
      setShowSettings((on) => !on)
    } else if (e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void newSession()
    } else if (e.key.toLowerCase() === 'w' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      const id = openId.current
      if (id && !showSettings && !e.repeat) void leaveSession(id)
    } else if (e.key.toLowerCase() === 'd' && e.shiftKey && !e.altKey) {
      e.preventDefault()
      void toggleReview()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      cycleSession(e.shiftKey)
    } else {
      const id = openId.current
      const result = s.shortcut(e, sideShown, () => {
        // Not from behind the settings screen.
        if (id && !showSettings) void popOut(id)
      })
      if (!result.handled) return
      e.preventDefault()
      if (result.leaveSettings) setShowSettings(false)
    }
  }
  const goRef = useRef(go)
  goRef.current = go
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => shortcuts.current(e)
    // Files dropped outside the composer must not navigate the window.
    const block = (e: DragEvent): void => e.preventDefault()
    // The mouse's back and forward buttons.
    const onMouse = (e: MouseEvent): void => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      if (e.type === 'mouseup') void goRef.current(e.button === 3 ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    window.addEventListener('mousedown', onMouse)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
      window.removeEventListener('mousedown', onMouse)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])

  const closeSettings = useCallback(() => setShowSettings(false), [])

  /** The agents' own sessions in the shown project; null until each agent has listed them. */
  const listedAgentSessions: ListedAgentSession[] | null = !projectPath
    ? []
    : agents.some((a) => a.available !== false && !(agentSessionsKey(projectPath, a.id) in agentSessions))
      ? null
      : agents.filter((a) => a.available !== false).flatMap((a) => (agentSessions[agentSessionsKey(projectPath, a.id)] ?? []).map((x) => ({ ...x, agentId: a.id })))
  const agentSessionsError = projectPath
    ? agents.map((a) => agentSessionErrors[agentSessionsKey(projectPath, a.id)]).filter(Boolean).join(' ') || null
    : null

  const open = s.open
  // The widths the panes want (dragged or default), fitted to what the window has room for now.
  const hasSide = open !== null && !showSettings
  const panes = fitPanes(
    windowWidth,
    {
      sidebar: sidebarHidden ? null : clampWidth(sidebarStored ?? SIDEBAR_DEFAULT, sidebarLimits(windowWidth)),
      side: !hasSide ? undefined : s.sideOpen ? (threadStored ?? threadPanelDefault(windowWidth)) : null
    },
    s.keepPane
  )
  const sidebarWidth = panes.sidebar
  const threadWidth = panes.side ?? null
  const sideShown = hasSide && threadWidth !== null
  const sidebarLimit = sidebarLimits(windowWidth, panes.side)
  const threadLimit = threadPanelLimits(windowWidth, sidebarWidth ?? SIDEBAR_RAIL)

  const sessionId = s.sessionId
  /** The panel's thread while it is expanded. */
  const panelThread = sideShown ? (s.panel?.threadId ?? null) : null
  // Each new view goes on the history, dropping the views ahead of it. Not while one is
  // restored, nor while another session loads (its panel is already cleared).
  useEffect(() => {
    const h = history.current
    if (h.moving) return
    let view: View
    if (showSettings) view = 'settings'
    else if (sessionId && openId.current === sessionId) view = { sessionId, threadId: panelThread }
    else return
    if (sameView(h.views[h.at], view)) return
    h.views = [...h.views.slice(0, h.at + 1), view]
    h.at = h.views.length - 1
  }, [showSettings, sessionId, panelThread, openId])

  return (
    <CaptureShortcut.Provider value={settings?.global.captureShortcut ?? ''}>
    <div className="app">
      <TitleBar />
      {sidebarWidth === null ? (
        <SidebarRail
          count={project ? sessions.filter((x) => sameFolder(x.cwd, project.path)).length : 0}
          onExpand={() => hideSidebar(false)}
        />
      ) : (
        <>
          <Sidebar
            agents={agents}
            defaultAgent={agent?.id ?? ''}
            rateLimits={rateLimits}
            onSetDefaultAgent={(id) => void updateSettings({ global: { defaultAgent: id as GlobalSettings['defaultAgent'] } })}
            width={sidebarWidth}
            projects={projects}
            project={project}
            sessions={sessions}
            openId={sessionId ?? null}
            popped={popped}
            running={running}
            unseen={unseen}
            waiting={s.requests}
            agentSessions={listedAgentSessions}
            order={settings?.global.sessionOrder ?? 'created'}
            agentSessionsError={agentSessionsError}
            importing={importing}
            creating={creating}
            note={sidebarNote}
            onDismissNote={() => setSidebarNote(null)}
            settingsOpen={showSettings}
            settingsError={settings?.error != null}
            onSelectProject={(path) => selectProject(path, sessions)}
            onOpenProject={() => void openProject()}
            onDeleteProject={(path) => void deleteProject(path)}
            onSelect={(id) => void selectSession(id)}
            onNew={(agentId) => void newSession(agentId)}
            onReview={(agentId) => void newReview(undefined, agentId)}
            onImport={(a) => void importSession(a)}
            onRename={(id, title) =>
              void window.gloss.sessions.rename(id, title).catch((err: unknown) => setSidebarError(errorText(err)))
            }
            onPopOut={(id) => void popOut(id)}
            onDelete={(id) => void deleteSession(id)}
            onCopyMarkdown={(id) => exportMarkdown(id, 'copy')}
            onSaveMarkdown={(id) => exportMarkdown(id, 'save')}
            onSearch={() => setShowSearch(true)}
            onSettings={() => setShowSettings((on) => !on)}
            onCollapse={() => hideSidebar(true)}
          />
          <ResizeHandle
            label="Resize sidebar"
            pane="before"
            limits={sidebarLimit}
            value={sidebarWidth}
            onResize={setSidebarWidth}
            onReset={() => setSidebarWidth(null)}
          />
        </>
      )}
      <div className="sheet">
        {showSettings ? (
          settings && (
            <SettingsScreen
              state={settings}
              projectPath={projectPath}
              projects={projects}
              onUpdate={updateSettings}
              onOpenFile={() => window.gloss.settings.openFile()}
              onClose={closeSettings}
            />
          )
        ) : open ? (
          <SessionPane
            s={s}
            open={open}
            settings={settings}
            agents={agents}
            sent={sent}
            sideShown={sideShown}
            threadWidth={threadWidth}
            threadLimit={threadLimit}
            onResizeThread={setThreadPanelWidth}
            creating={creating}
            onNewReview={(from) => void newReview(from)}
            popped={false}
            onWindow={() => void popOut(open.session.id)}
          />
        ) : (
          // The bead beside the wordmark, or beside the project's name, and one action.
          <main className="empty-state">
            {project ? (
              <>
                <div className="lockup project" title={project.path}>
                  <BrandMark size={44} />
                  <span>{project.name}</span>
                </div>
                <button
                  className="primary lg"
                  onClick={() => void newSession()}
                  disabled={!agent || creating}
                  title={agent ? `New session with ${agent.name} (Ctrl+N)` : undefined}
                >
                  {!creating && <Plus />}
                  {creating ? 'Opening session…' : 'New session'}
                </button>
              </>
            ) : (
              <>
                <div className="lockup" role="img" aria-label="Gloss">
                  <BrandMark size={52} />
                  <span aria-hidden="true">gloss</span>
                </div>
                <button className="primary lg" onClick={() => void openProject()}>
                  <FolderOpen />
                  Open a project folder…
                </button>
              </>
            )}
          </main>
        )}
      </div>
      {fullScreenHint > 0 && <FullScreenHint key={fullScreenHint} />}
      {showSearch && <SearchDialog sessionId={sessionId ?? null} cwd={projectPath} onClose={() => setShowSearch(false)} onOpen={openSearchResult} />}
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
