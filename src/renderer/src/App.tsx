import type { SearchResult } from '@shared/search'
import { SearchDialog } from './SearchDialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatus, GlossEvent, PullRequest, SettingsPatch, SettingsState } from '@shared/ipc'
import { sameFolder } from '@shared/paths'
import { projectSettings, type GlobalSettings } from '@shared/settings'
import type {
  AgentInfo,
  AgentSession,
  Anchor,
  Attachment,
  AuthMethodInfo,
  Message,
  MessageQueue,
  Plan,
  Project,
  QueuedMessage,
  Session,
  SessionLive,
  Thread,
  ToolCall
} from '@shared/types'
import { lineLabel, type LineAnchor } from '@shared/review'
import type { UserRequest } from '@shared/requests'
import { pinAnchor, truncate } from '@shared/wire'
import type { ListItemSpan } from './anchors'
import { GeneralPanel, ReviewThreadList } from './ReviewPanels'
import { locations as threadLocations } from './reviewThreads'
import { useReviewSources } from './reviewSources'
import { hideFileList, ReviewView, type DiffState } from './ReviewView'
import { CAPTURE, FOCUS_COMPOSER, FOCUS_MAIN_COMPOSER, type ComposerQueue } from './Composer'
import { errorText } from './errors'
import { Conversation, type StripThread } from './Conversation'
import type { Notice, Reveal } from './Log'
import { Sidebar, SidebarRail, type ListedAgentSession, type SidebarNote } from './Sidebar'
import type { SourceSelection } from './SelectionMenu'
import { SettingsScreen } from './SettingsScreen'
import { SignInDialog } from './SignInDialog'
import { ThreadPanel } from './ThreadPanel'
import { SideRail, ThreadsOverview, type SideTab } from './ThreadsOverview'
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
import { applyTheme } from './theme'
import { FolderOpen, Plus } from 'lucide-react'
import { BrandMark, TitleBar } from './Brand'
import { playChime } from './chime'

export type OpenSession = {
  session: Session
  messages: Message[]
  toolCalls: ToolCall[]
  plans: Plan[]
  threads: Thread[]
  /** Questions and approvals the agent is waiting on, shown in their threads' logs. */
  requests?: UserRequest[]
}

/**
 * The thread shown in the side panel. threadId is null until the first message creates the thread.
 * anchorMessageId is null for a line anchor in a review session.
 */
export type Panel = { anchorMessageId: string | null; anchor: Anchor; threadId: string | null }

/** A place back and forward return to: the settings screen, or a session and its open thread. */
type View = { sessionId: string; threadId: string | null } | 'settings'

function sameView(a: View | undefined, b: View): boolean {
  return a === b || (a !== undefined && a !== 'settings' && b !== 'settings' && a.sessionId === b.sessionId && a.threadId === b.threadId)
}

export type SignInRequest = { agentId: string; agentName: string; methods: AuthMethodInfo[] }

const NO_LIVE: SessionLive = {
  attached: false,
  model: null,
  effort: null,
  commands: [],
  usage: null,
  rateLimits: [],
  modes: null,
  autoApprove: false,
  accepts: { image: false, file: false },
  steering: false
}

function agentSessionsKey(path: string, id: string): string {
  return `${path}\0${id}`
}

const NO_QUEUE: MessageQueue = { items: [], paused: false }
const NO_REQUESTS: UserRequest[] = []
const NO_THREADS: Thread[] = []

/** Most recent activity first, as the main process lists them. */
function byActivity(list: Session[]): Session[] {
  return list.sort((a, b) => (b.activeAt ?? b.createdAt) - (a.activeAt ?? a.createdAt) || b.createdAt - a.createdAt)
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

/** A thread's name: the start of the list item or selection it replies to; a review finding's title, or the lines. */
/** "Press F11 to exit full screen", shown for a few seconds after entering it. */
function FullScreenHint(): React.JSX.Element | null {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), 3000)
    return () => clearTimeout(timer)
  }, [])
  if (!shown) return null
  return (
    <div className="fullscreen-hint" role="status">
      Press <kbd>F11</kbd> to exit full screen
    </div>
  )
}

/**
 * What the collapsed side panel counts: a session's threads, or for a review its open
 * line threads plus the general conversation, which the panel also holds.
 */
function sideRailCount(open: OpenSession, isReview: boolean): { count: number; label?: string } {
  if (!isReview) return { count: open.threads.length }
  const threads = open.threads.filter((t) => t.anchor.kind === 'line' && t.resolvedAt === undefined).length
  return {
    count: threads + 1,
    label: `the general conversation and ${threads} open ${threads === 1 ? 'thread' : 'threads'}`
  }
}

function threadName(thread: Thread): string {
  if (thread.finding) return truncate(thread.finding.title, 40)
  return thread.anchor.kind === 'line' ? lineLabel(thread.anchor) : truncate(thread.anchor.text, 40)
}

/** Waits this long after a change before reading a review's diff again. */
const DIFF_REFRESH_DELAY = 300

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Session[]>([])
  /** Messages sent in every session, newest first, each once (SPEC → Composer → History). */
  const [sent, setSent] = useState<string[]>([])
  /** Project path and agent id → the agent's sessions there that Gloss has no record of. */
  const [agentSessions, setAgentSessions] = useState<Record<string, AgentSession[]>>({})
  const [agentSessionErrors, setAgentSessionErrors] = useState<Record<string, string | null>>({})
  const [importing, setImporting] = useState<string | null>(null)
  const [open, setOpen] = useState<OpenSession | null>(null)
  /** The thread in the side panel; null shows the threads overview. Kept while the panel is collapsed. */
  const [panel, setPanelState] = useState<Panel | null>(null)
  /** A review session's side panel shows its general conversation (when no thread is open). */
  const [general, setGeneral] = useState(false)
  /** A thread, or the overview: either way not the general conversation. */
  const setPanel = useCallback((p: Panel | null | ((old: Panel | null) => Panel | null)) => {
    setGeneral(false)
    setPanelState(p)
  }, [])
  /** The open review session's diff (SPEC → Review sessions). */
  const [reviewDiff, setReviewDiff] = useState<(DiffState & { sessionId: string }) | null>(null)
  const diffTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const panelRef = useRef(panel)
  panelRef.current = panel
  /** Session id → its side panel's thread, while another session is open (not kept across restarts). */
  const panels = useRef(new Map<string, Panel | null>())
  /** A message to scroll to and highlight, in whichever log shows it. */
  const [reveal, setReveal] = useState<Reveal | null>(null)
  /** The side panel is expanded. It starts collapsed on every launch. */
  const [sideOpen, setSideOpen] = useState(false)
  /** The pane opened last, which stays open when the window is too narrow for both. */
  const [keepPane, setKeepPane] = useState<'sidebar' | 'side'>('side')
  /** The overview's tab: the threads, or the queue. */
  const [sideTab, setSideTab] = useState<SideTab>('threads')
  /** sessionId → threadId of its running turn. */
  const [running, setRunning] = useState<Record<string, string | null>>({})
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
  }, [clearUnseen])
  // The app icon's badge: a failed turn, else a finished one, else working (SPEC → Notifications).
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
  const [notices, setNotices] = useState<Record<string, Notice[]>>({})
  const [lives, setLives] = useState<Record<string, SessionLive>>({})
  const [queues, setQueues] = useState<Record<string, MessageQueue>>({})
  /** sessionId → what its agent is waiting on the user for (SPEC → Questions and approvals). */
  const [requests, setRequests] = useState<Record<string, UserRequest[]>>({})
  const [git, setGit] = useState<GitStatus | null>(null)
  const [pr, setPr] = useState<PullRequest | null>(null)
  const [signIn, setSignIn] = useState<SignInRequest | null>(null)
  const [creating, setCreating] = useState(false)
  /** Counts entries into full screen; each shows the hint on how to leave again. */
  const [fullScreenHint, setFullScreenHint] = useState(0)
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
    if (!hidden) setKeepPane('sidebar')
    if (hidden) localStorage.setItem('gloss.sidebarHidden', '1')
    else localStorage.removeItem('gloss.sidebarHidden')
  }

  const openId = useRef<string | null>(null)
  /** Settings' turnEndSound, for the event handler. */
  const chimeOn = useRef(true)
  chimeOn.current = settings?.global.turnEndSound ?? true
  /** Views visited, and the current one; `moving` while back or forward restores one. */
  const history = useRef<{ views: View[]; at: number; moving: boolean }>({ views: [], at: -1, moving: false })
  /** The open session's folder, for refreshing its git status. */
  const openCwd = useRef<string | null>(null)
  /** The open session is a review: its diff follows the agent's edits. */
  const openReview = useRef(false)
  const lastSeq = useRef(-1)
  /** "cwd\0branch" → its pull request, so switching sessions shows it straight away. */
  const prCache = useRef(new Map<string, PullRequest | null>())
  const project = projects.find((p) => projectPath !== null && sameFolder(p.path, projectPath)) ?? null
  const agent = settings ? agents.find((a) => a.id === settings.global.defaultAgent) ?? agents[0] : undefined

  /** Expands the side panel. */
  const openSide = useCallback(() => {
    setSideOpen(true)
    setKeepPane('side')
  }, [])

  /** Opens a thread in the side panel, expanding it. */
  const showPanel = useCallback(
    (p: Panel) => {
      setPanel(p)
      openSide()
    },
    [setPanel, openSide]
  )

  /** Opens the side panel on its Queue tab. */
  const showQueue = useCallback(() => {
    setPanel(null)
    setSideTab('queue')
    openSide()
  }, [setPanel, openSide])

  /** Collapses the side panel; it reopens on the same thread. */
  const collapseSide = useCallback(() => setSideOpen(false), [])

  /** Remembers the open session's thread for when it is shown again. */
  const leaveSession = useCallback(() => {
    if (openId.current) panels.current.set(openId.current, panelRef.current)
  }, [])

  const addNotice = useCallback((sessionId: string, threadId: string | null, text: string, tone?: Notice['tone'], action?: Notice['action']) => {
    setNotices((all) => ({
      ...all,
      [sessionId]: [
        ...(all[sessionId] ?? []),
        {
          id: crypto.randomUUID(),
          threadId,
          text,
          ...(tone ? { tone } : {}),
          ...(action ? { action } : {}),
          afterSeq: openId.current === sessionId ? lastSeq.current : Infinity
        }
      ]
    }))
  }, [])

  const refreshPr = useCallback((cwd: string, branch: string, sessionId: string) => {
    void window.gloss.git.pullRequest(cwd).then((found) => {
      prCache.current.set(`${cwd}\0${branch}`, found)
      if (openId.current === sessionId) setPr(found)
    })
  }, [])

  /** Refreshes the branch, then its pull request (`gh` is slower, so a cached one shows first). */
  const refreshGit = useCallback(
    (cwd: string, sessionId: string) => {
      void window.gloss.git.status(cwd).then((status) => {
        if (openId.current !== sessionId) return
        setGit(status)
        if (!status || status.branch === 'detached HEAD') {
          setPr(null)
          return
        }
        setPr(prCache.current.get(`${cwd}\0${status.branch}`) ?? null)
        refreshPr(cwd, status.branch, sessionId)
      })
    },
    [refreshPr]
  )

  /** Reads the review's diff again shortly, once changes settle (the agent edits files in bursts). */
  const refreshDiff = useCallback((sessionId: string, now = false) => {
    clearTimeout(diffTimer.current)
    diffTimer.current = setTimeout(
      () => {
        window.gloss.sessions.reviewDiff(sessionId).then(
          (diff) => {
            if (openId.current === sessionId) setReviewDiff({ sessionId, diff, error: null })
          },
          (err: unknown) => {
            if (openId.current === sessionId) {
              setReviewDiff((d) => ({ sessionId, diff: d?.sessionId === sessionId ? d.diff : null, error: errorText(err) }))
            }
          }
        )
      },
      now ? 0 : DIFF_REFRESH_DELAY
    )
  }, [])

  const refreshProjects = useCallback(async () => setProjects(await window.gloss.projects.list()), [])

  /** Lists every agent's own sessions in the project. */
  const loadAgentSessions = useCallback(
    async (path: string) => {
      await Promise.all(
        agents.filter((a) => a.available !== false).map(async (a) => {
          const key = agentSessionsKey(path, a.id)
          setAgentSessionErrors((all) => ({ ...all, [key]: null }))
          try {
            const list = await window.gloss.projects.agentSessions(path, a.id)
            setAgentSessions((all) => ({ ...all, [key]: list }))
          } catch (err) {
            setAgentSessionErrors((all) => ({ ...all, [key]: `Couldn't list ${a.name} sessions: ${errorText(err)}` }))
            setAgentSessions((all) => ({ ...all, [key]: [] }))
          }
        })
      )
    },
    [agents]
  )

  const selectSession = useCallback(
    async (id: string, threadId: string | null = null, target?: SearchResult): Promise<void> => {
      setShowSettings(false)
      clearUnseen(id)
      const switching = openId.current !== id
      if (switching) {
        leaveSession()
        setPanel(null)
        setGit(null)
        setPr(null)
        setReviewDiff(null)
      }
      openId.current = id
      const view = await window.gloss.sessions.open(id)
      if (openId.current !== id) return
      if (target && !(target.kind === 'tool' ? view.toolCalls : view.messages).some((item) => item.id === target.id)) {
        throw new Error('This result is no longer in the session. Search again.')
      }
      if (switching) setPanel(panels.current.get(id) ?? null)
      lastSeq.current = Math.max(-1, ...view.messages.map((m) => m.seq), ...view.toolCalls.map((t) => t.messageSeq))
      setOpen({
        session: view.session,
        messages: view.messages,
        toolCalls: view.toolCalls,
        plans: view.plans,
        threads: view.threads
      })
      openCwd.current = view.session.cwd
      openReview.current = view.session.review !== undefined
      setProjectPath(view.session.cwd)
      setLives((l) => ({ ...l, [id]: view.live }))
      setQueues((q) => ({ ...q, [id]: view.queue }))
      setRequests((r) => ({ ...r, [id]: view.requests }))
      setRunning((r) => {
        const next = { ...r }
        if (view.turn) next[id] = view.turn.threadId
        else delete next[id]
        return next
      })
      refreshGit(view.session.cwd, id)
      if (view.session.review) refreshDiff(id, true)
      const thread = threadId ? view.threads.find((t) => t.id === threadId) : undefined
      if (thread) showPanel({ anchorMessageId: thread.anchorMessageId, anchor: thread.anchor, threadId: thread.id })
    },
    [refreshGit, refreshDiff, showPanel, leaveSession, setPanel]
  )

  async function openSearchResult(result: SearchResult): Promise<void> {
    await selectSession(result.sessionId, result.threadId, result)
    if (openId.current !== result.sessionId) return
    if (result.threadId === null) {
      // A review's main thread is its general conversation, in the side panel.
      if (openReview.current) openGeneral()
      else setPanel(null)
    }
    setReveal({ messageId: result.kind === 'tool' ? `tool:${result.id}` : result.id, key: Date.now() })
  }

  /** Shows a project: its most recent session, or none. */
  const selectProject = useCallback(
    (path: string, all: Session[]) => {
      setProjectPath(path)
      const first = all.find((s) => sameFolder(s.cwd, path))
      if (first) {
        if (first.id !== openId.current) void selectSession(first.id)
      } else {
        leaveSession()
        openId.current = null
        setOpen(null)
        setPanel(null)
      }
    },
    [selectSession, leaveSession]
  )

  const onEvent = useCallback(
    (event: GlossEvent) => {
      switch (event.type) {
        case 'session':
          setSessions((list) => byActivity(upsert(list, event.session)))
          setOpen((o) => (o && o.session.id === event.session.id ? { ...o, session: event.session } : o))
          break
        case 'fullScreen':
          setFullScreenHint((n) => n + 1)
          break
        case 'sessionDeleted':
          panels.current.delete(event.sessionId)
          setSessions((list) => list.filter((s) => s.id !== event.sessionId))
          setRequests((r) => {
            const next = { ...r }
            delete next[event.sessionId]
            return next
          })
          if (event.deletedOutside) {
            setSidebarNote({ text: `“${event.deletedOutside.title}” was deleted outside Gloss, so it was removed here too.`, tone: 'info' })
          }
          if (openId.current === event.sessionId) {
            openId.current = null
            setOpen(null)
            setPanel(null)
          }
          break
        case 'sessionSynced':
          // Refresh the log without navigating, closing settings, or moving focus.
          if (openId.current === event.sessionId) {
            void window.gloss.sessions.open(event.sessionId).then((view) => {
              if (openId.current !== event.sessionId) return
              lastSeq.current = Math.max(-1, ...view.messages.map((m) => m.seq), ...view.toolCalls.map((t) => t.messageSeq))
              setOpen((o) => o?.session.id === event.sessionId ? {
                session: view.session, messages: view.messages, toolCalls: view.toolCalls, plans: view.plans, threads: view.threads
              } : o)
            }).catch((err: unknown) => addNotice(event.sessionId, null, errorText(err)))
          }
          break
        case 'sessionCleared':
          panels.current.delete(event.sessionId)
          setNotices((all) => ({ ...all, [event.sessionId]: [] }))
          if (openId.current === event.sessionId) {
            lastSeq.current = -1
            setOpen((o) => (o ? { ...o, messages: [], toolCalls: [], plans: [], threads: [] } : o))
            setPanel(null)
          }
          break
        case 'live':
          setLives((l) => ({ ...l, [event.sessionId]: event.live }))
          break
        case 'queue':
          setQueues((q) => ({ ...q, [event.sessionId]: event.queue }))
          break
        case 'requests':
          setRequests((r) => ({ ...r, [event.sessionId]: event.requests }))
          break
        case 'reveal':
          void selectSession(event.sessionId, event.threadId)
          break
        case 'message': {
          const { sessionId: of, createdAt } = event.message
          if (createdAt !== undefined) {
            setSessions((list) =>
              list.some((s) => s.id === of && (s.activeAt ?? s.createdAt) < createdAt)
                ? byActivity(list.map((s) => (s.id === of ? { ...s, activeAt: createdAt } : s)))
                : list
            )
          }
          const { role, text } = event.message
          if (role === 'user' && text) setSent((h) => (h[0] === text ? h : [text, ...h.filter((t) => t !== text)]))
          if (event.message.sessionId !== openId.current) break
          lastSeq.current = Math.max(lastSeq.current, event.message.seq)
          setOpen((o) => (o ? { ...o, messages: upsert(o.messages, event.message) } : o))
          break
        }
        case 'messageDeleted':
          if (event.sessionId !== openId.current) break
          setOpen((o) => (o ? { ...o, messages: o.messages.filter((m) => m.id !== event.messageId) } : o))
          break
        case 'toolCall':
          if (event.toolCall.sessionId !== openId.current) break
          lastSeq.current = Math.max(lastSeq.current, event.toolCall.messageSeq)
          setOpen((o) => (o ? { ...o, toolCalls: upsert(o.toolCalls, event.toolCall) } : o))
          // The agent may have changed files: the review's diff shows its edits as it makes them.
          if (openReview.current && event.toolCall.status === 'completed') refreshDiff(event.toolCall.sessionId)
          break
        case 'plan':
          if (event.plan.sessionId !== openId.current) break
          lastSeq.current = Math.max(lastSeq.current, event.plan.seq)
          setOpen((o) => (o ? { ...o, plans: upsert(o.plans, event.plan) } : o))
          break
        case 'thread':
          if (event.thread.sessionId !== openId.current) break
          setOpen((o) => (o ? { ...o, threads: upsert(o.threads, event.thread) } : o))
          break
        case 'turnStart':
          setRunning((r) => ({ ...r, [event.sessionId]: event.threadId }))
          clearUnseen(event.sessionId)
          break
        case 'turnEnd': {
          const recovery = event.recovery
          const action: Notice['action'] = recovery ? {
            label: recovery.action === 'signIn' ? 'Sign in' : 'Retry',
            run: async () => {
              await window.gloss.retry(event.sessionId, recovery.messageId)
              setNotices((all) => ({
                ...all, [event.sessionId]: (all[event.sessionId] ?? []).map((n) => n.action === action ? { ...n, action: undefined } : n)
              }))
            }
          } : undefined
          setRunning((r) => {
            const next = { ...r }
            delete next[event.sessionId]
            return next
          })
          if (event.error) addNotice(event.sessionId, event.threadId, `The turn failed: ${event.error}`, 'failed', action)
          else if (event.stopReason === 'cancelled') addNotice(event.sessionId, event.threadId, 'Cancelled.')
          else if (event.stopReason && event.stopReason !== 'end_turn')
            addNotice(event.sessionId, event.threadId, `The agent stopped: ${event.stopReason.replace(/_/g, ' ')}.`, 'failed', action)
          // Work the user isn't watching (another session, or Gloss in the background) is
          // marked unseen and chimes. A cancel is the user's own; a queued follow-up isn't the end.
          if (
            !event.continues &&
            event.stopReason !== 'cancelled' &&
            (event.sessionId !== openId.current || !document.hasFocus())
          ) {
            const outcome = event.error ? 'failed' : 'completed'
            setUnseen((u) => ({ ...u, [event.sessionId]: outcome }))
            if (chimeOn.current) playChime()
          }
          // The agent may have changed files: refresh the branch's dirty marker.
          if (event.sessionId === openId.current && openCwd.current) refreshGit(openCwd.current, event.sessionId)
          if (event.sessionId === openId.current && openReview.current) refreshDiff(event.sessionId)
          break
        }
        case 'notice':
          addNotice(event.sessionId, event.threadId, event.text)
          break
        case 'authRequired':
          setSignIn({ agentId: event.agentId, agentName: event.agentName, methods: event.methods })
          break
        case 'authResolved':
          setSignIn((s) => (s?.agentId === event.agentId ? null : s))
          break
        case 'settings':
          setSettings(event.state)
          void window.gloss.agents.list().then(setAgents)
          break
      }
    },
    [addNotice, refreshGit, refreshDiff, selectSession, setPanel]
  )

  useEffect(() => window.gloss.onEvent(onEvent), [onEvent])

  const theme = settings?.global.theme ?? 'system'
  useEffect(() => applyTheme(theme), [theme])

  useEffect(() => {
    void window.gloss.settings.get().then(setSettings)
    void window.gloss.history().then(setSent)
    void window.gloss.agents.list().then(setAgents)
    void Promise.all([window.gloss.projects.list(), window.gloss.sessions.list()]).then(([ps, list]) => {
      setProjects(ps)
      setSessions(list)
      if (list[0]) void selectSession(list[0].id)
      else if (ps[0]) setProjectPath(ps[0].path)
    })
  }, [selectSession])

  // While the PR's checks run, poll it so their result shows without a turn. Only
  // while the window is focused: `gh` makes a network call each time.
  const pollPr = pr !== null && (pr.state === 'open' || pr.state === 'draft') && pr.checks === 'pending'
  const branch = git?.branch
  useEffect(() => {
    if (!pollPr || !branch) return
    const timer = setInterval(() => {
      const sessionId = openId.current
      if (document.hasFocus() && sessionId && openCwd.current) refreshPr(openCwd.current, branch, sessionId)
    }, 90_000)
    return () => clearInterval(timer)
  }, [pollPr, branch, refreshPr])

  // The agent's sessions for the shown project, listed when it is shown.
  useEffect(() => {
    if (projectPath) void loadAgentSessions(projectPath)
  }, [projectPath, loadAgentSessions])

  // Back in the window: pick up what was done in the agent's CLI meanwhile (SPEC → Shared sessions).
  useEffect(() => {
    const onFocus = (): void => {
      if (openId.current) void window.gloss.sessions.refresh(openId.current)
      if (openId.current && openReview.current) refreshDiff(openId.current, true)
      if (projectPath) void loadAgentSessions(projectPath)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [projectPath, loadAgentSessions, refreshDiff])

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
   * Starts a review of the project's branch (SPEC → Review sessions) with the default
   * agent, or a fresh one of an open review (**New review**): same agent and range.
   */
  async function newReview(from?: Session): Promise<void> {
    const cwd = from?.cwd ?? projectPath
    const agentId = from?.agentId ?? agent?.id
    if (!cwd || !agentId) return
    setSidebarError(null)
    setCreating(true)
    try {
      const review = from?.review
      const session = await window.gloss.sessions.createReview(cwd, agentId, review?.baseRef, review?.headRef ?? null)
      // A new review starts with only the diff: the session list, the side panel and the
      // file list closed. Each remembers what it is set to from then on.
      hideFileList()
      hideSidebar(true)
      await selectSession(session.id)
      setSideOpen(false)
      // The first pass runs in the general conversation, which the side panel opens on.
      setGeneral(true)
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
    const deleted = sessions.find((s) => s.id === id)
    try {
      const warning = await window.gloss.sessions.delete(id)
      if (warning) setSidebarError(warning)
      // Show the next session in the project, if the deleted one was open.
      if (deleted && openId.current === null) {
        const rest = sessions.filter((s) => s.id !== id)
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
        openId.current = null
        setOpen(null)
        setPanel(null)
      }
    } catch (err) {
      setSidebarError(errorText(err))
    }
  }

  function exportMarkdown(id: string, threadId: string | null, how: 'copy' | 'save'): void {
    const done =
      how === 'copy' ? window.gloss.sessions.copyMarkdown(id, threadId) : window.gloss.sessions.saveMarkdown(id, threadId)
    done.catch((err: unknown) => addNotice(id, threadId, `Couldn't export: ${errorText(err)}`))
  }

  function openItem(message: Message, span: ListItemSpan): void {
    if (!open) return
    const existing = open.threads.find(
      (t) =>
        t.anchorMessageId === message.id &&
        t.anchor.kind === 'listItem' &&
        t.anchor.path.length === 1 &&
        t.anchor.path[0] === span.index
    )
    showPanel(
      existing
        ? { anchorMessageId: message.id, anchor: existing.anchor, threadId: existing.id }
        : {
            anchorMessageId: message.id,
            anchor: { kind: 'listItem', path: [span.index], text: span.text },
            threadId: null
          }
    )
  }

  function openSelection(message: Message, selection: SourceSelection): void {
    if (!open) return
    const existing = open.threads.find(
      (t) =>
        t.anchorMessageId === message.id &&
        t.anchor.kind === 'selection' &&
        t.anchor.start === selection.start &&
        t.anchor.end === selection.end
    )
    showPanel(
      existing
        ? { anchorMessageId: message.id, anchor: existing.anchor, threadId: existing.id }
        : { anchorMessageId: message.id, anchor: { kind: 'selection', ...selection }, threadId: null }
    )
  }

  /** Opens the thread on a pin of an annotated screenshot, or a new one (SPEC → Visual feedback). */
  function openPin(message: Message, image: number, pin: number): void {
    if (!open) return
    const existing = open.threads.find(
      (t) => t.anchorMessageId === message.id && t.anchor.kind === 'pin' && t.anchor.image === image && t.anchor.pin === pin
    )
    if (existing) return showPanel({ anchorMessageId: message.id, anchor: existing.anchor, threadId: existing.id })
    try {
      showPanel({ anchorMessageId: message.id, anchor: pinAnchor(message.attachments ?? [], image, pin), threadId: null })
    } catch {
      // Not a pin of this message: nothing to open.
    }
  }

  function openThread(threadId: string): void {
    const t = open?.threads.find((x) => x.id === threadId)
    if (t) showPanel({ anchorMessageId: t.anchorMessageId, anchor: t.anchor, threadId: t.id })
  }

  /** Opens the thread on selected diff lines, or a new one (SPEC → Review sessions → Line anchors). */
  function openLines(anchor: LineAnchor): void {
    const existing = open?.threads.find(
      (t) =>
        t.anchor.kind === 'line' &&
        t.anchor.file === anchor.file &&
        t.anchor.side === anchor.side &&
        t.anchor.start === anchor.start &&
        t.anchor.end === anchor.end
    )
    showPanel(
      existing
        ? { anchorMessageId: null, anchor: existing.anchor, threadId: existing.id }
        : { anchorMessageId: null, anchor, threadId: null }
    )
  }

  /** A review's general conversation in the side panel. */
  function openGeneral(): void {
    setPanelState(null)
    setGeneral(true)
    openSide()
  }

  async function send(
    text: string,
    attachments: Attachment[],
    target: Panel | null,
    how: 'send' | 'steer' = 'send',
    /** A main-thread message sent from this thread (SPEC → Send to main). */
    fromThread: string | null = null
  ): Promise<void> {
    if (!open) return
    const sessionId = open.session.id
    let threadId: string | null = null
    try {
      if (target) {
        threadId = target.threadId
        if (threadId === null) {
          // The thread is created by its first message (SPEC → Data model).
          const thread = await window.gloss.threads.create(sessionId, target.anchorMessageId, target.anchor)
          threadId = thread.id
          setOpen((o) => (o && o.session.id === sessionId ? { ...o, threads: upsert(o.threads, thread) } : o))
          setPanel((p) => (p === target ? { ...target, threadId: thread.id } : p))
        }
      }
      // Turn errors arrive as turnEnd events.
      if (how === 'steer') await window.gloss.steer(sessionId, text, threadId, attachments)
      else await window.gloss.send(sessionId, text, threadId, attachments, fromThread)
    } catch (err) {
      addNotice(sessionId, threadId, errorText(err))
    }
  }

  async function updateSettings(patch: SettingsPatch): Promise<void> {
    setSettings(await window.gloss.settings.update(patch))
    if (patch.global && ('opencodeExecutable' in patch.global || 'agentProfiles' in patch.global)) setAgents(await window.gloss.agents.list())
  }

  /** Puts the caret in the main conversation's composer, or the side panel's, once it shows. */
  function focusComposer(main: boolean): void {
    setTimeout(() => window.dispatchEvent(new Event(main ? FOCUS_MAIN_COMPOSER : FOCUS_COMPOSER)))
  }

  /** Where the agent works, or last worked: the running turn's thread, else the latest sent message's. */
  function jumpToWork(): void {
    if (!open) return
    const sessionRunning = open.session.id in running
    const last = open.messages.reduce<Message | undefined>(
      (latest, m) => (m.role === 'user' && (!latest || m.seq > latest.seq) ? m : latest),
      undefined
    )
    const threadId = sessionRunning ? running[open.session.id] : last?.threadId
    if (threadId === undefined) return
    setShowSettings(false)
    if (threadId !== null) openThread(threadId)
    else if (open.session.review) openGeneral()
    focusComposer(threadId === null)
  }

  /** Scrolls to a sent message and highlights it, opening its thread. */
  function revealMessage(message: Message): void {
    setShowSettings(false)
    if (message.threadId !== null) openThread(message.threadId)
    else if (open?.session.review) openGeneral()
    setReveal({ messageId: message.id, key: Date.now() })
  }

  /** Scrolls the main conversation to a thread's anchor and highlights it. */
  function findInMain(p: Panel): void {
    if (p.anchorMessageId !== null) setReveal({ messageId: p.anchorMessageId, threadId: p.threadId, key: Date.now() })
  }

  // The highlight fades; a log shown later mustn't scroll to it again.
  useEffect(() => {
    if (!reveal) return
    const timer = setTimeout(() => setReveal(null), 2500)
    return () => clearTimeout(timer)
  }, [reveal])

  /** Back (-1) or forward (1) through the views visited, skipping deleted sessions. */
  async function go(step: -1 | 1): Promise<void> {
    const h = history.current
    let i = h.at + step
    const gone = (v: View): boolean => v !== 'settings' && !sessions.some((s) => s.id === v.sessionId)
    while (h.views[i] && gone(h.views[i])) i += step
    const view = h.views[i]
    if (!view || h.moving) return
    h.at = i
    if (view === 'settings') return setShowSettings(true)
    h.moving = true
    try {
      setShowSettings(false)
      if (view.sessionId !== openId.current) await selectSession(view.sessionId, view.threadId)
      else if (view.threadId) openThread(view.threadId)
      else setPanel(null)
    } finally {
      h.moving = false
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
    } else if (e.key.toLowerCase() === 't' && e.shiftKey && !e.altKey) {
      e.preventDefault()
      if (sideShown) collapseSide()
      else openSide()
    } else if (e.key.toLowerCase() === 'q' && e.shiftKey && !e.altKey) {
      e.preventDefault()
      if (open) {
        setShowSettings(false)
        showQueue()
      }
    } else if (e.key.toLowerCase() === 's' && e.shiftKey && !e.altKey) {
      // Capture and annotate (SPEC → Visual feedback): the composer used last takes it.
      e.preventDefault()
      if (open && !showSettings) window.dispatchEvent(new Event(CAPTURE))
    } else if (e.key.toLowerCase() === 'j' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      jumpToWork()
    } else if (e.key.toLowerCase() === 'l' && !e.shiftKey) {
      e.preventDefault()
      setShowSettings(false)
      window.dispatchEvent(new Event(FOCUS_COMPOSER))
    } else if (e.key === 'Tab' || e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault()
      const list = projectPath ? sessions.filter((s) => sameFolder(s.cwd, projectPath)) : sessions
      if (list.length === 0) return
      const back = e.key === 'PageUp' || (e.key === 'Tab' && e.shiftKey)
      const i = list.findIndex((s) => s.id === openId.current)
      const next = list[(i === -1 ? 0 : i + (back ? list.length - 1 : 1)) % list.length]
      void selectSession(next.id)
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

  // The widths the panes want (dragged or default), fitted to what the window has room for now.
  const hasSide = open !== null && !showSettings
  const panes = fitPanes(
    windowWidth,
    {
      sidebar: sidebarHidden ? null : clampWidth(sidebarStored ?? SIDEBAR_DEFAULT, sidebarLimits(windowWidth)),
      side: !hasSide ? undefined : sideOpen ? (threadStored ?? threadPanelDefault(windowWidth)) : null
    },
    keepPane
  )
  const sidebarWidth = panes.sidebar
  const threadWidth = panes.side ?? null
  const sideShown = hasSide && threadWidth !== null
  const sidebarLimit = sidebarLimits(windowWidth, panes.side)
  const threadLimit = threadPanelLimits(windowWidth, sidebarWidth ?? SIDEBAR_RAIL)

  const sessionId = open?.session.id
  /** The panel's thread while it is expanded. */
  const shownPanel = sideShown ? panel : null
  const panelThread = shownPanel?.threadId ?? null
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
  }, [showSettings, sessionId, panelThread])
  const runningThread = sessionId !== undefined && sessionId in running ? running[sessionId] : undefined
  const runningThreadRow = open?.threads.find((t) => t.id === runningThread)
  /**
   * Where a turn runs (a thread or the main conversation), else where the latest message
   * was sent, with its state.
   */
  const lastMessage = open?.messages.reduce<Message | undefined>(
    (latest, m) => (m.role === 'user' && (!latest || m.seq > latest.seq) ? m : latest),
    undefined
  )
  const stripThreadId = runningThread !== undefined ? runningThread : lastMessage?.threadId
  const stripThreadRow = open?.threads.find((t) => t.id === stripThreadId)
  const stripState = runningThread !== undefined
    ? ((sessionId && requests[sessionId]?.length) ? 'waiting' : 'working')
    : (lastMessage?.outcome ?? null)
  const lastThread: StripThread | null = stripThreadRow
    ? { id: stripThreadRow.id, name: threadName(stripThreadRow), state: stripState }
    : stripThreadId === null
      ? { id: null, name: 'main conversation', state: stripState }
      : null
  const sessionNotices = sessionId ? (notices[sessionId] ?? []) : []
  const isReview = open?.session.review !== undefined
  const diffState: DiffState =
    reviewDiff && reviewDiff.sessionId === sessionId ? reviewDiff : { diff: null, error: null }
  const openThreads = open?.threads
  const reviewSources = useReviewSources(isReview ? (sessionId ?? null) : null, open?.session.review, diffState.diff, openThreads ?? NO_THREADS)
  const lineLocations = useMemo(
    () => threadLocations(openThreads ?? [], diffState.diff, reviewSources.sources),
    [openThreads, diffState.diff, reviewSources.sources]
  )
  const live = (sessionId && lives[sessionId]) || NO_LIVE
  const queue = (sessionId && queues[sessionId]) || NO_QUEUE
  const sessionRequests = (sessionId && requests[sessionId]) || NO_REQUESTS
  /** The open session with what its agent waits on, for the logs. */
  const openShown = useMemo(() => (open ? { ...open, requests: sessionRequests } : null), [open, sessionRequests])
  /** Part of the session's queue (one thread's messages) with the queue's actions, for a composer. */
  const composerQueue = (id: string, items: QueuedMessage[]): ComposerQueue => ({
    items,
    paused: queue.paused,
    onEdit: (itemId, text) => window.gloss.queue.edit(id, itemId, text),
    onRemove: (itemId) => window.gloss.queue.remove(id, itemId),
    onResume: () => window.gloss.queue.resume(id)
  })

  return (
    <div className="app">
      <TitleBar />
      {sidebarWidth === null ? (
        <SidebarRail
          running={Object.keys(running).length > 0}
          waiting={Object.values(requests).some((r) => r.length > 0)}
          onExpand={() => hideSidebar(false)}
        />
      ) : (
        <>
          <Sidebar
            agents={agents}
            defaultAgent={agent?.id ?? ''}
            onSetDefaultAgent={(id) => void updateSettings({ global: { defaultAgent: id as GlobalSettings['defaultAgent'] } })}
            width={sidebarWidth}
            projects={projects}
            project={project}
            sessions={sessions}
            openId={sessionId ?? null}
            running={running}
            unseen={unseen}
            waiting={requests}
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
            onReview={() => void newReview()}
            onImport={(a) => void importSession(a)}
            onRename={(id, title) =>
              void window.gloss.sessions.rename(id, title).catch((err: unknown) => setSidebarError(errorText(err)))
            }
            onDelete={(id) => void deleteSession(id)}
            onCopyMarkdown={(id) => exportMarkdown(id, null, 'copy')}
            onSaveMarkdown={(id) => exportMarkdown(id, null, 'save')}
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
        {showSettings && settings ? (
          <SettingsScreen
            state={settings}
            projectPath={projectPath}
            projects={projects}
            onUpdate={updateSettings}
            onOpenFile={() => window.gloss.settings.openFile()}
            onClose={closeSettings}
          />
        ) : open && isReview ? (
          <ReviewView
            obsidianVault={settings ? projectSettings(settings.projects, open.session.cwd).obsidianVault : undefined}
            key={open.session.id}
            open={openShown ?? open}
            agentName={agents.find((a) => a.id === open.session.agentId)?.name ?? open.session.agentId}
            diff={diffState}
            locations={lineLocations}
            sources={reviewSources.sources}
            onReadSource={reviewSources.read}
            panel={shownPanel}
            runningThread={runningThread}
            live={live}
            git={git}
            pr={pr}
            queue={queue}
            onResumeQueue={() => void window.gloss.queue.resume(open.session.id)}
            onSetChoice={(kind, value) => window.gloss.sessions.setChoice(open.session.id, kind, value)}
            onCommand={(text) => void send(text, [], null)}
            onOpenThread={openThread}
            onReplyLines={openLines}
            creating={creating}
            onNewReview={() => void newReview(open.session)}
            onOpenFile={(path, how, line) => {
              const id = open.session.id
              window.gloss.sessions.openReviewFile(id, path, how, line).catch((err: unknown) => addNotice(id, null, errorText(err)))
            }}
            onSetRange={(range) => {
              const id = open.session.id
              window.gloss.sessions.setReviewRange(id, range.baseRef, range.headRef ?? null).then(
                (diff) => {
                  if (openId.current === id) setReviewDiff({ sessionId: id, diff, error: null })
                },
                (err: unknown) => addNotice(id, null, errorText(err))
              )
            }}
          />
        ) : open ? (
          <Conversation
            obsidianVault={settings ? projectSettings(settings.projects, open.session.cwd).obsidianVault : undefined}
            key={open.session.id}
            open={openShown ?? open}
            listItemReplies={settings?.global.listItemReplies ?? false}
            agentName={agents.find((a) => a.id === open.session.agentId)?.name ?? open.session.agentId}
            live={live}
            history={sent}
            git={git}
            pr={pr}
            runningThread={runningThread}
            lastThread={lastThread}
            notices={sessionNotices}
            panel={shownPanel}
            reveal={reveal}
            queue={queue}
            composerQueue={composerQueue(
              open.session.id,
              queue.items.filter((q) => q.threadId === null)
            )}
            onSend={(text, attachments) => void send(text, attachments, null)}
            onSteer={(text, attachments) => void send(text, attachments, null, 'steer')}
            onCancel={() => void window.gloss.cancel(open.session.id)}
            onSetChoice={(kind, value) => window.gloss.sessions.setChoice(open.session.id, kind, value)}
            onOpenItem={openItem}
            onOpenSelection={openSelection}
            onOpenPin={openPin}
            onOpenThread={openThread}
            onOpenMain={() => focusComposer(true)}
            onOpenQueue={showQueue}
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
                  {creating ? 'Starting the agent…' : 'New session'}
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
        {open && !showSettings && !sideShown && (
          <SideRail
            {...sideRailCount(open, isReview)}
            running={runningThreadRow !== undefined}
            onExpand={openSide}
          />
        )}
        {open && !showSettings && sideShown && (
          <>
            <ResizeHandle
              label="Resize side panel"
              pane="after"
              limits={threadLimit}
              value={threadWidth}
              onResize={setThreadPanelWidth}
              onReset={() => setThreadPanelWidth(null)}
            />
            {isReview && general && !panel ? (
              <GeneralPanel
                width={threadWidth}
                open={openShown ?? open}
                notices={sessionNotices}
                reveal={reveal}
                live={live}
                history={sent}
                runningThread={runningThread}
                queue={composerQueue(
                  open.session.id,
                  queue.items.filter((q) => q.threadId === null)
                )}
                onSend={(text, attachments) => void send(text, attachments, null)}
                onSteer={(text, attachments) => void send(text, attachments, null, 'steer')}
                onCancel={() => void window.gloss.cancel(open.session.id)}
                onBack={() => setPanel(null)}
                onClose={collapseSide}
                onOpenThread={openThread}
              />
            ) : panel ? (
              <ThreadPanel
                location={panel.threadId !== null ? lineLocations.get(panel.threadId) : undefined}
                onResolve={(threadId, resolved) =>
                  void window.gloss.threads
                    .resolve(open.session.id, threadId, resolved)
                    .catch((err: unknown) => addNotice(open.session.id, threadId, errorText(err)))
                }
                width={threadWidth}
                open={openShown ?? open}
                panel={panel}
                reveal={reveal}
                backTo={sideTab}
                runningThread={runningThread}
                notices={sessionNotices}
                live={live}
                history={sent}
                // A thread that doesn't exist yet has nothing queued.
                queue={composerQueue(
                  open.session.id,
                  panel.threadId === null ? [] : queue.items.filter((q) => q.threadId === panel.threadId)
                )}
                onSend={(text, attachments) => void send(text, attachments, panel)}
                onSteer={(text, attachments) => void send(text, attachments, panel, 'steer')}
                onSendToMain={(text, attachments) => void send(text, attachments, null, 'send', panel.threadId)}
                onCancel={() => void window.gloss.cancel(open.session.id)}
                onBack={() => setPanel(null)}
                onClose={collapseSide}
                onOpenPin={openPin}
                onCopyMarkdown={(threadId) => exportMarkdown(open.session.id, threadId, 'copy')}
                onSaveMarkdown={(threadId) => exportMarkdown(open.session.id, threadId, 'save')}
                // A review's conversation is in the General panel, which this panel replaces.
                onFindInMain={
                  panel.anchorMessageId !== null && !isReview
                    ? () => findInMain(panel)
                    : undefined
                }
              />
            ) : (
              <ThreadsOverview
                width={threadWidth}
                open={openShown ?? open}
                tab={sideTab}
                onTab={setSideTab}
                runningThread={runningThread}
                queue={queue}
                name={threadName}
                onOpenThread={openThread}
                onFindInMain={
                  isReview ? undefined : (t) => findInMain({ anchorMessageId: t.anchorMessageId, anchor: t.anchor, threadId: t.id })
                }
                onReveal={revealMessage}
                onOpenMain={() => {
                  if (isReview) openGeneral()
                  focusComposer(true)
                }}
                onEditQueued={(id, text) => window.gloss.queue.edit(open.session.id, id, text)}
                onRemoveQueued={(id) => window.gloss.queue.remove(open.session.id, id)}
                onResumeQueue={() => window.gloss.queue.resume(open.session.id)}
                onCollapse={collapseSide}
                review={
                  isReview
                    ? {
                        count: open.threads.filter((t) => t.anchor.kind === 'line').length,
                        content: (
                          <ReviewThreadList
                            open={openShown ?? open}
                            diff={diffState.diff}
                            locations={lineLocations}
                            runningThread={runningThread}
                            queue={queue}
                            onOpenThread={openThread}
                            onOpenGeneral={openGeneral}
                          />
                        )
                      }
                    : undefined
                }
              />
            )}
          </>
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
  )
}
