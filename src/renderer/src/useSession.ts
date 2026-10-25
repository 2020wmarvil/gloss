// The open session's state and actions: its log, side panel, review diff and status,
// kept current from main-process events. The main window and a session window
// (SPEC → Session windows) each hold one.
import type { SearchResult } from '@shared/search'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatus, GlossEvent, PaneState, PullRequest, SessionView } from '@shared/ipc'
import type { Anchor, Attachment, Message, MessageQueue, Plan, QueuedMessage, Session, SessionLive, Thread, ToolCall } from '@shared/types'
import { lineLabel, type LineAnchor, type ReviewDiff } from '@shared/review'
import type { UserRequest } from '@shared/requests'
import { pinAnchor, truncate } from '@shared/wire'
import type { ListItemSpan } from './anchors'
import type { DiffState } from './ReviewView'
import { FOCUS_COMPOSER, FOCUS_MAIN_COMPOSER, restoreDrafts, sessionDrafts, type ComposerQueue } from './Composer'
import { errorText } from './errors'
import type { StripThread } from './Conversation'
import type { Notice, Reveal } from './Log'
import type { SourceSelection } from './SelectionMenu'
import type { SideTab } from './ThreadsOverview'
import { restoreScrolls, sessionScrolls } from './scrollMemory'

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

const NO_QUEUE: MessageQueue = { items: [], paused: false }
const NO_REQUESTS: UserRequest[] = []

export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i === -1) return [...list, item]
  const next = list.slice()
  next[i] = item
  return next
}

/** A thread's name: the start of the list item or selection it replies to; a review finding's title, or the lines. */
export function threadName(thread: Thread): string {
  if (thread.finding) return truncate(thread.finding.title, 40)
  return thread.anchor.kind === 'line' ? lineLabel(thread.anchor) : truncate(thread.anchor.text, 40)
}

/** Waits this long after a change before reading a review's diff again. */
const DIFF_REFRESH_DELAY = 300

function maxSeq(view: { messages: Message[]; toolCalls: ToolCall[] }): number {
  return Math.max(-1, ...view.messages.map((m) => m.seq), ...view.toolCalls.map((t) => t.messageSeq))
}

export type SessionState = ReturnType<typeof useSession>

export function useSession() {
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
  const [notices, setNotices] = useState<Record<string, Notice[]>>({})
  const [lives, setLives] = useState<Record<string, SessionLive>>({})
  const [queues, setQueues] = useState<Record<string, MessageQueue>>({})
  /** sessionId → what its agent is waiting on the user for (SPEC → Questions and approvals). */
  const [requests, setRequests] = useState<Record<string, UserRequest[]>>({})
  const [git, setGit] = useState<GitStatus | null>(null)
  const [pr, setPr] = useState<PullRequest | null>(null)

  const openId = useRef<string | null>(null)
  /** The open session's folder, for refreshing its git status. */
  const openCwd = useRef<string | null>(null)
  /** The open session is a review: its diff follows the agent's edits. */
  const openReview = useRef(false)
  const lastSeq = useRef(-1)
  /** "cwd\0branch" → its pull request, so switching sessions shows it straight away. */
  const prCache = useRef(new Map<string, PullRequest | null>())
  /** The open review's expanded files, as its view reports them, for moving it to another window. */
  const expandedFiles = useRef<string[]>([])
  /** Files to expand when a review opens, from the window it came from. */
  const pendingExpanded = useRef<{ sessionId: string; files: string[] } | null>(null)

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

  /** Shows the diff a range change returned, if its review is still open. */
  const showDiff = useCallback((sessionId: string, diff: ReviewDiff) => {
    if (openId.current === sessionId) setReviewDiff({ sessionId, diff, error: null })
  }, [])

  /**
   * Opens a session (and thread). Resolves to its view, or null when another session was
   * opened meanwhile. A search `target` that is no longer in the session throws.
   */
  const load = useCallback(
    async (id: string, threadId: string | null = null, target?: SearchResult): Promise<SessionView | null> => {
      const switching = openId.current !== id
      if (switching) {
        leaveSession()
        setPanel(null)
        setGit(null)
        setPr(null)
        setReviewDiff(null)
        expandedFiles.current = []
        if (pendingExpanded.current?.sessionId !== id) pendingExpanded.current = null
      }
      openId.current = id
      const view = await window.gloss.sessions.open(id)
      if (openId.current !== id) return null
      if (target && !(target.kind === 'tool' ? view.toolCalls : view.messages).some((item) => item.id === target.id)) {
        throw new Error('This result is no longer in the session. Search again.')
      }
      if (switching) setPanel(panels.current.get(id) ?? null)
      lastSeq.current = maxSeq(view)
      setOpen({
        session: view.session,
        messages: view.messages,
        toolCalls: view.toolCalls,
        plans: view.plans,
        threads: view.threads
      })
      openCwd.current = view.session.cwd
      openReview.current = view.session.review !== undefined
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
      return view
    },
    [refreshGit, refreshDiff, showPanel, leaveSession, setPanel]
  )

  /** Shows no session. */
  const close = useCallback(() => {
    leaveSession()
    openId.current = null
    setOpen(null)
    setPanel(null)
  }, [leaveSession, setPanel])

  /** What the open session's view shows, to carry it to another window (SPEC → Session windows). */
  const snapshot = useCallback(
    (): PaneState => {
      const id = openId.current
      return {
        threadId: panelRef.current?.threadId ?? null,
        sideOpen,
        general: general && panelRef.current === null,
        sideTab,
        expandedFiles: expandedFiles.current,
        drafts: id ? sessionDrafts(id) : {},
        scroll: id ? sessionScrolls(id) : {}
      }
    },
    [sideOpen, general, sideTab]
  )

  /** Opens a session as another window showed it. */
  const restore = useCallback(
    async (id: string, state: PaneState): Promise<SessionView | null> => {
      restoreDrafts(id, state.drafts)
      restoreScrolls(id, state.scroll)
      pendingExpanded.current = { sessionId: id, files: state.expandedFiles }
      const view = await load(id, state.threadId)
      if (!view) return null
      expandedFiles.current = state.expandedFiles
      setSideTab(state.sideTab)
      if (state.general && !state.threadId) {
        setPanelState(null)
        setGeneral(true)
      }
      if (state.sideOpen) openSide()
      else setSideOpen(false)
      return view
    },
    [load, openSide]
  )

  /** The files a review opens with expanded: those it had in the window it came from. */
  const takeExpanded = useCallback((sessionId: string): string[] => {
    const pending = pendingExpanded.current
    return pending?.sessionId === sessionId ? pending.files : []
  }, [])

  const onEvent = useCallback(
    (event: GlossEvent) => {
      switch (event.type) {
        case 'session':
          setOpen((o) => (o && o.session.id === event.session.id ? { ...o, session: event.session } : o))
          break
        case 'sessionDeleted':
          panels.current.delete(event.sessionId)
          setRequests((r) => {
            const next = { ...r }
            delete next[event.sessionId]
            return next
          })
          if (openId.current === event.sessionId) {
            openId.current = null
            setOpen(null)
            setPanel(null)
          }
          break
        case 'sessionRewound':
        case 'sessionSynced':
          if (event.type === 'sessionRewound') {
            panels.current.delete(event.sessionId)
            setNotices((all) => ({ ...all, [event.sessionId]: [] }))
            if (openId.current === event.sessionId) setPanel(null)
          }
          // Refresh the log without navigating, closing settings, or moving focus.
          if (openId.current === event.sessionId) {
            void window.gloss.sessions.open(event.sessionId).then((view) => {
              if (openId.current !== event.sessionId) return
              lastSeq.current = maxSeq(view)
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
        case 'message':
          if (event.message.sessionId !== openId.current) break
          lastSeq.current = Math.max(lastSeq.current, event.message.seq)
          setOpen((o) => (o ? { ...o, messages: upsert(o.messages, event.message) } : o))
          break
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
          // The agent may have changed files: refresh the branch's dirty marker.
          if (event.sessionId === openId.current && openCwd.current) refreshGit(openCwd.current, event.sessionId)
          if (event.sessionId === openId.current && openReview.current) refreshDiff(event.sessionId)
          break
        }
        case 'notice':
          addNotice(event.sessionId, event.threadId, event.text)
          break
      }
    },
    [addNotice, refreshGit, refreshDiff, setPanel]
  )

  useEffect(() => window.gloss.onEvent(onEvent), [onEvent])

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

  // Back in the window: pick up what was done in the agent's CLI meanwhile (SPEC → Shared sessions).
  useEffect(() => {
    const onFocus = (): void => {
      if (openId.current) void window.gloss.sessions.refresh(openId.current)
      if (openId.current && openReview.current) refreshDiff(openId.current, true)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshDiff])

  // The highlight fades; a log shown later mustn't scroll to it again.
  useEffect(() => {
    if (!reveal) return
    const timer = setTimeout(() => setReveal(null), 2500)
    return () => clearTimeout(timer)
  }, [reveal])

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

  /** **Run review**: the agent reviews the diff in the general conversation, which opens to show it. */
  function runReview(sessionId: string): void {
    openGeneral()
    window.gloss.sessions.runReview(sessionId).catch((err: unknown) => addNotice(sessionId, null, errorText(err)))
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

  /** Puts the caret in the main conversation's composer, or the side panel's, once it shows. */
  function focusComposer(main: boolean): void {
    setTimeout(() => window.dispatchEvent(new Event(main ? FOCUS_MAIN_COMPOSER : FOCUS_COMPOSER)))
  }

  /**
   * Where the agent works, or last worked: the running turn's thread, else the latest sent
   * message's. False when there is nowhere to go.
   */
  function jumpToWork(): boolean {
    if (!open) return false
    const sessionRunning = open.session.id in running
    const last = open.messages.reduce<Message | undefined>(
      (latest, m) => (m.role === 'user' && (!latest || m.seq > latest.seq) ? m : latest),
      undefined
    )
    const threadId = sessionRunning ? running[open.session.id] : last?.threadId
    if (threadId === undefined) return false
    if (threadId !== null) openThread(threadId)
    else if (open.session.review) openGeneral()
    focusComposer(threadId === null)
    return true
  }

  /** Scrolls to a sent message and highlights it, opening its thread. */
  function revealMessage(message: Message): void {
    if (message.threadId !== null) openThread(message.threadId)
    else if (open?.session.review) openGeneral()
    setReveal({ messageId: message.id, key: Date.now() })
  }

  /** Scrolls the main conversation to a thread's anchor and highlights it. */
  function findInMain(p: Panel): void {
    if (p.anchorMessageId !== null) setReveal({ messageId: p.anchorMessageId, threadId: p.threadId, key: Date.now() })
  }

  /**
   * The open session's shortcuts (SPEC → Keyboard shortcuts), in either window: the side
   * panel, the queue, where the agent works, the composer, and pop out or return
   * (`onWindow`). `handled` when the key was one of them; `leaveSettings` when it showed
   * something of the session.
   */
  function shortcut(e: KeyboardEvent, sideShown: boolean, onWindow: () => void): { handled: boolean; leaveSettings: boolean } {
    const none = { handled: false, leaveSettings: false }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return none
    const key = e.key.toLowerCase()
    if (key === 't' && e.shiftKey) {
      if (sideShown) collapseSide()
      else openSide()
      return { handled: true, leaveSettings: false }
    }
    if (key === 'q' && e.shiftKey) {
      if (open) showQueue()
      return { handled: true, leaveSettings: open !== null }
    }
    if (key === 'j' && !e.shiftKey) return { handled: true, leaveSettings: jumpToWork() }
    if (key === 'l' && !e.shiftKey) {
      window.dispatchEvent(new Event(FOCUS_COMPOSER))
      return { handled: true, leaveSettings: true }
    }
    if (key === 'o' && e.shiftKey) {
      if (open) onWindow()
      return { handled: true, leaveSettings: false }
    }
    return none
  }

  const sessionId = open?.session.id
  const runningThread = sessionId !== undefined && sessionId in running ? running[sessionId] : undefined
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

  return {
    open,
    openId,
    openReview,
    panel,
    setPanel,
    general,
    setGeneral,
    reveal,
    setReveal,
    sideOpen,
    setSideOpen,
    keepPane,
    setKeepPane,
    sideTab,
    setSideTab,
    running,
    requests,
    git,
    pr,
    expandedFiles,
    load,
    close,
    snapshot,
    restore,
    takeExpanded,
    showDiff,
    openSide,
    showPanel,
    showQueue,
    collapseSide,
    addNotice,
    openItem,
    openSelection,
    openPin,
    openThread,
    openLines,
    openGeneral,
    runReview,
    send,
    focusComposer,
    jumpToWork,
    revealMessage,
    findInMain,
    shortcut,
    sessionId,
    runningThread,
    lastThread,
    sessionNotices,
    isReview,
    diffState,
    live,
    queue,
    sessionRequests,
    openShown,
    composerQueue
  }
}
