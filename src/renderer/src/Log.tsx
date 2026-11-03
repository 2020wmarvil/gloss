// The message log shared by the main view and the thread panel.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { afterPaintIdle } from './idle'
import { LogToBottom } from './logToBottom'
import { hasPendingScroll, useScrollMemory, type ScrollAnchors } from './scrollMemory'
import type { Message, Plan, ToolCall } from '@shared/types'
import { splitForkSummary, threadToMainTag } from '@shared/wire'
import type { OpenSession } from './App'
import { Markdown, MarkdownImageDirectory } from './Markdown'
import { RequestCard } from './RequestCard'
import { CaptureFigure, type PinAnchors } from './CaptureFigure'
import type { UserRequest } from '@shared/requests'
import { hasDetails, ToolDetails } from './ToolDetails'
import { ArrowDown, Brain, Check, ChevronDown, ChevronRight, CircleAlert, FilePen, FileText, GitFork, Globe, Search, Terminal, Trash, Wrench, type LucideIcon } from 'lucide-react'

/** A transient, client-side note shown in a log (not part of the conversation). */
export type Notice = { id: string; threadId: string | null; text: string; afterSeq: number; tone?: 'failed'; action?: { label: string; run(): Promise<unknown> } }

export type LogItem =
  | { kind: 'message'; seq: number; message: Message }
  | { kind: 'sentToMain'; seq: number; message: Message }
  | { kind: 'tool'; seq: number; toolCall: ToolCall }
  | { kind: 'plan'; seq: number; plan: Plan }
  | { kind: 'notice'; seq: number; notice: Notice }
  /** What the agent waits on the user for: always last, below the turn that asked. */
  | { kind: 'request'; seq: number; request: UserRequest }

/** Messages, tool calls, plans and notices of one thread (null = main), in seq order. */
export function logItems(open: OpenSession, notices: Notice[], threadId: string | null): LogItem[] {
  // These are references to existing main messages, not additional agent messages.
  // Derive them from persisted wire tags so older conversations also show them.
  const continuations: LogItem[] = []
  // A fork thread's messages are numbered in the fork's own session (SPEC → Fork threads):
  // a message sent to main from it goes after the fork's latest one sent before it.
  const isFork = threadId !== null && open.threads.some((t) => t.id === threadId && t.fork)
  const own = isFork ? open.messages.filter((m) => m.threadId === threadId) : []
  const placed = (m: Message): number =>
    isFork ? Math.max(-1, ...own.filter((x) => (x.createdAt ?? 0) <= (m.createdAt ?? 0)).map((x) => x.seq)) + 0.5 : m.seq
  if (threadId !== null) {
    const active = new Map<string, number>()
    for (const m of [...open.messages].sort((a, b) => a.seq - b.seq)) {
      if (m.threadId !== null) { active.set(m.threadId, m.seq); continue }
      if (m.role !== 'user' || !m.wireText) continue
      const tag = m.wireText.split('\n', 1)[0]
      const source = open.threads.filter((t) => threadToMainTag(t.anchor) === tag)
        .sort((a, b) => (active.get(b.id) ?? -1) - (active.get(a.id) ?? -1) || b.createdAt - a.createdAt)[0]
      if (source) active.set(source.id, m.seq)
      if (source?.id === threadId) continuations.push({ kind: 'sentToMain', seq: placed(m), message: m })
    }
  }
  return [
    ...continuations,
    ...open.messages
      .filter((m) => m.threadId === threadId)
      .map((m): LogItem => ({ kind: 'message', seq: m.seq, message: m })),
    ...open.toolCalls
      .filter((t) => t.threadId === threadId)
      .map((t): LogItem => ({ kind: 'tool', seq: t.messageSeq, toolCall: t })),
    ...open.plans
      .filter((p) => p.threadId === threadId && p.entries.length > 0)
      .map((p): LogItem => ({ kind: 'plan', seq: p.seq, plan: p })),
    ...notices
      .filter((n) => n.threadId === threadId)
      .map((n): LogItem => ({ kind: 'notice', seq: n.afterSeq + 0.5, notice: n })),
    ...(open.requests ?? [])
      .filter((r) => r.threadId === threadId)
      .map((r): LogItem => ({ kind: 'request', seq: Number.MAX_SAFE_INTEGER, request: r }))
  ].sort((a, b) => a.seq - b.seq)
}

/** The fork's summary sent with a message from a fork thread (SPEC → Fork threads), under it. */
export function ForkSummary({ message }: { message: Message }): React.JSX.Element | null {
  const summary = message.wireText ? splitForkSummary(message.wireText)?.summary : undefined
  if (!summary) return null
  return (
    <details className="fork-summary" open>
      <summary>
        <GitFork aria-hidden />
        Summary from the fork, sent with this message
      </summary>
      <Markdown text={summary} />
    </details>
  )
}

/**
 * A message to scroll to and highlight; `key` repeats it for the same message.
 * With `threadId`, the thread's anchor inside it is the target where it's found.
 */
export type Reveal = { messageId: string; threadId?: string | null; key: number }

type Props = {
  /** Composer, optional activity strip and status line, pinned inside the full-height scroller. */
  footer?: ReactNode
  cwd?: string
  items: LogItem[]
  className: string
  empty: ReactNode
  renderAgent(message: Message): ReactNode
  reveal?: Reveal | null
  /** A user message to show as a status line instead (a review Gloss asked for), or null. */
  systemLine?(message: Message): string | null
  /** Makes annotated screenshots' pins anchors (SPEC → Visual feedback). */
  pins?: PinAnchors
  /** Names the log so its scroll position moves with its session to another window (SPEC → Session windows). */
  scrollKey?: string
  /** Opens the actual main-thread message referenced by a Send to main marker. */
  onRevealMain?(message: Message): void
  /**
   * What a message's row shows besides the message itself (its threads, the panel's anchor),
   * as a string. A row whose message and version are unchanged isn't rendered again, so a
   * streamed chunk renders only its own message (SPEC → Performance). Without it, every row is.
   */
  version?(message: Message): string
}

/** How long a batch of older entries may take to render before the next is smaller. */
const BATCH_MS = 24

/** A log's position: a message, and the paragraph, list item or code block at the top. */
const LOG_ANCHORS: ScrollAnchors = { item: '[data-message-id]', attr: 'data-message-id', block: 'p, li, pre, h1, h2, h3, h4, h5, h6, blockquote, tr' }

/** A scrolling log that sticks to the bottom while new output arrives. */
export function Log({ footer, cwd, items, className, empty, renderAgent, reveal, systemLine, pins, scrollKey, onRevealMain, version }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // Rows render with the latest of these; a row that isn't rendered again keeps what it had.
  const render = useRef<RowRender>({ renderAgent, pins, onRevealMain })
  render.current = { renderAgent, pins, onRevealMain }
  const stickToBottom = useRef(true)
  const lastTop = useRef(0)
  // Scrolled away from the bottom, and whether output arrived since: shows Jump to latest.
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)
  const groups = useMemo(() => groupTools(items), [items])
  // Small logs mount as usual. Larger histories let the composer paint first, then
  // mount recent entries, and older ones in batches as the view nears them (SPEC → Performance).
  // A position restored from another window may be anywhere, so it mounts them all.
  const initial = groups.length > 12 && !hasPendingScroll(scrollKey) ? groups.length : 0
  const [history, setHistory] = useState({ key: scrollKey, remaining: initial })
  if (history.key !== scrollKey) setHistory({ key: scrollKey, remaining: initial })
  const remaining = reveal ? 0 : Math.min(history.key === scrollKey ? history.remaining : initial, groups.length)
  const prepend = useRef<{ node: HTMLElement; top: number } | null>(null)
  const earlier = useRef<HTMLParagraphElement>(null)
  /** Groups per batch, sized so a batch takes about BATCH_MS to render. */
  const batch = useRef<{ size: number; startedAt: number | null }>({ size: 8, startedAt: null })
  /** Bumped when the view comes near the entries not mounted yet. */
  const [near, setNear] = useState(0)
  useEffect(() => {
    if (reveal) {
      setHistory((h) => h.remaining === 0 ? h : { ...h, remaining: 0 })
      return
    }
    if (remaining === 0) return
    const el = ref.current
    const marker = earlier.current
    // Within two screens of the view: mount the next batch. Otherwise wait until it is.
    const margin = (el?.clientHeight ?? 0) * 2
    if (el && marker && typeof IntersectionObserver !== 'undefined' &&
        marker.getBoundingClientRect().bottom < el.getBoundingClientRect().top - margin) {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear((n) => n + 1)
      }, { root: el, rootMargin: `${margin}px 0px 0px 0px` })
      observer.observe(marker)
      return () => observer.disconnect()
    }
    return afterPaintIdle(() => {
      const el = ref.current
      if (el && !stickToBottom.current) {
        const top = el.getBoundingClientRect().top
        const node = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find((n) => n.getBoundingClientRect().bottom > top)
        if (node) prepend.current = { node, top: node.getBoundingClientRect().top }
      }
      batch.current.startedAt = performance.now()
      const size = batch.current.size
      setHistory((h) => ({ ...h, remaining: Math.max(0, Math.min(h.remaining, groups.length) - size) }))
    })
  }, [remaining, groups.length, scrollKey, reveal, near])
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useLayoutEffect(() => () => clearTimeout(scrollTimer.current), [])
  useLayoutEffect(() => {
    stickToBottom.current = true
    prepend.current = null
    setAway(false)
    setFresh(false)
  }, [scrollKey])
  // Changes when output arrives: a new entry, streamed text or a tool call's progress.
  const tail = items.at(-1)
  const output = `${items.length}:${tail?.kind === 'message' ? tail.message.text.length : tail?.kind === 'tool' ? tail.toolCall.status : ''}`
  const lastOutput = useRef(output)
  useEffect(() => {
    if (lastOutput.current === output) return
    lastOutput.current = output
    if (!stickToBottom.current) setFresh(true)
  }, [output])
  useLayoutEffect(() => {
    const b = batch.current
    if (b.startedAt !== null) {
      // Halve batches that blocked input for long, grow ones that were quick.
      const ms = performance.now() - b.startedAt
      b.size = ms > BATCH_MS ? Math.max(1, b.size >> 1) : ms < BATCH_MS / 3 ? Math.min(32, b.size * 2) : b.size
      b.startedAt = null
    }
    const el = ref.current
    if (!el) return
    if (stickToBottom.current) el.scrollTop = el.scrollHeight
    else if (prepend.current?.node.isConnected) el.scrollTop += prepend.current.node.getBoundingClientRect().top - prepend.current.top
    prepend.current = null
  }, [remaining, scrollKey])
  // After the stick-to-bottom scroll above, so a position from another window wins.
  useScrollMemory(ref, scrollKey, LOG_ANCHORS, () => {
    stickToBottom.current = false
  })

  // When the pane gets shorter (the composer grows a line), the text at its bottom moves up
  // with it instead of going under the composer.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let height = el.clientHeight
    // Where it was scrolled before the resize: a taller pane has already clamped scrollTop.
    let top = el.scrollTop
    const onScroll = (): void => {
      top = el.scrollTop
    }
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight
      else if (el.clientHeight !== height) el.scrollTop = top + height - el.clientHeight
      height = el.clientHeight
      top = el.scrollTop
    })
    observer.observe(el)
    // Content and composer growth should keep a bottom-pinned log at the bottom too.
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    el.addEventListener('scroll', onScroll)
    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  // After the stick-to-bottom scroll above, so it wins.
  useLayoutEffect(() => {
    const message = reveal && ref.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(reveal.messageId)}"]`)
    if (!message) return
    const target =
      (reveal.threadId && message.querySelector<HTMLElement>(`[data-thread="${CSS.escape(reveal.threadId)}"]`)) ||
      (reveal.threadId !== undefined && message.querySelector<HTMLElement>('.anchor-item.active, .pin-target.active')) ||
      message
    stickToBottom.current = false
    target.scrollIntoView?.({ block: 'center' })
    target.classList.remove('revealed')
    void target.offsetWidth // restarts the highlight animation
    target.classList.add('revealed')
  }, [reveal])

  const toBottom = useCallback(() => {
    const el = ref.current
    if (!el) return
    stickToBottom.current = true
    el.scrollTop = el.scrollHeight
  }, [])

  return (
    <MarkdownImageDirectory value={cwd}>
      <LogToBottom.Provider value={toBottom}>
      <div
        className="log-scroll"
        ref={ref}
        onLoadCapture={() => {
          const el = ref.current
          if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
        }}
        onScroll={(e) => {
          const el = e.currentTarget
          // Only scrolling up lets go of the bottom. Measured alone, the distance also counts
          // output that arrived after a scroll Gloss made itself, before its event came.
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) stickToBottom.current = true
          else if (el.scrollTop < lastTop.current) stickToBottom.current = false
          lastTop.current = el.scrollTop
          setAway(!stickToBottom.current)
          if (stickToBottom.current) setFresh(false)
          el.classList.add('scrolling')
          clearTimeout(scrollTimer.current)
          scrollTimer.current = setTimeout(() => el.classList.remove('scrolling'), 900)
        }}
      >
        <div className={footer ? 'log-layout' : undefined}>
          <div className={className}>
            {items.length === 0 && empty}
            {remaining > 0 && <p className="muted" role="status" ref={earlier}>Loading earlier messages…</p>}
            {groups.slice(remaining).map((item) => (
              <LogRow
                key={rowKey(item)}
                item={item}
                reveal={reveal}
                line={!Array.isArray(item) && item.kind === 'message' && item.message.role === 'user' ? (systemLine?.(item.message) ?? null) : null}
                version={version && !Array.isArray(item) && item.kind === 'message' ? version(item.message) : undefined}
                render={render}
              />
            ))}
          </div>
          {footer && (
            <div className="log-footer">
              {away && items.length > 0 && (
                <>
                  <div className="log-fade" aria-hidden="true" />
                  <button
                    className={fresh ? 'jump-latest fresh' : 'jump-latest'}
                    onClick={() => ref.current?.scrollTo?.({ top: ref.current.scrollHeight, behavior: 'smooth' })}
                  >
                    <ArrowDown aria-hidden />
                    {fresh ? 'New output' : 'Jump to latest'}
                  </button>
                </>
              )}
              {footer}
            </div>
          )}
        </div>
      </div>
      </LogToBottom.Provider>
    </MarkdownImageDirectory>
  )
}

/** A thread header's turn state: working, or waiting for the user's answer in the log. */
export function TurnStatus({ open, threadId }: { open: OpenSession; threadId: string | null }): React.JSX.Element {
  const waiting = open.requests?.some((r) => r.threadId === threadId) ?? false
  return (
    <span className="status">
      <span className={waiting ? 'waiting-dot' : 'running-dot'} aria-hidden="true" />
      {waiting ? 'Waiting for you' : 'Working'}
    </span>
  )
}

function FailedNotice({ notice }: { notice: Notice }): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  async function recover(): Promise<void> {
    if (!notice.action || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setError(null)
    try {
      await notice.action.run()
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }
  return (
    <div className="notice failed" role="alert">
      <CircleAlert className="notice-icon" aria-hidden />
      <div className="notice-content">
        <span>{notice.text}</span>
        {notice.action && !done && <button className="notice-action" disabled={pending} onClick={() => void recover()}>{pending ? 'Waiting?' : notice.action.label}</button>}
        {error && <span className="notice-action-error">{error}</span>}
      </div>
    </div>
  )
}

/** What rows render with, current as of the log's latest render. */
type RowRender = Pick<Props, 'renderAgent' | 'pins' | 'onRevealMain'>

type RowItem = LogItem | ToolItem[]

function rowKey(item: RowItem): string {
  if (Array.isArray(item)) return item[0].toolCall.id
  switch (item.kind) {
    case 'sentToMain':
      return `sent-to-main:${item.message.id}`
    case 'message':
      return item.message.id
    case 'plan':
      return item.plan.id
    case 'request':
      return item.request.id
    case 'notice':
      return item.notice.id
    case 'tool':
      return item.toolCall.id
  }
}

type RowProps = {
  item: RowItem
  reveal?: Reveal | null
  /** A user message shown as a status line instead. */
  line: string | null
  version: string | undefined
  render: React.RefObject<RowRender>
}

/** Rendered again only when what it shows changed (see Props.version). */
function sameRow(a: RowProps, b: RowProps): boolean {
  if (Array.isArray(a.item) || Array.isArray(b.item)) {
    return Array.isArray(a.item) && Array.isArray(b.item) && a.reveal === b.reveal &&
      a.item.length === b.item.length && a.item.every((t, i) => t.toolCall === (b.item as ToolItem[])[i].toolCall)
  }
  const x = a.item
  const y = b.item
  switch (x.kind) {
    case 'message':
    case 'sentToMain':
      return y.kind === x.kind && y.message === x.message && a.version !== undefined && a.version === b.version && a.line === b.line
    case 'plan':
      return y.kind === 'plan' && y.plan === x.plan
    case 'request':
      return y.kind === 'request' && y.request === x.request
    case 'notice':
      return y.kind === 'notice' && y.notice === x.notice
    default:
      return false
  }
}

const LogRow = memo(function LogRow({ item, reveal, line, render }: RowProps): React.JSX.Element | null {
  const { renderAgent, pins, onRevealMain } = render.current
  if (Array.isArray(item)) return <ToolGroup tools={item} reveal={reveal} />
  switch (item.kind) {
    case 'sentToMain':
      return (
        <div className="sent-to-main-trace">
          <button className="ghost sm" onClick={() => onRevealMain?.(item.message)} title="Show this message in the main conversation">
            Sent to main <ChevronRight aria-hidden />
          </button>
          <p>{item.message.text || item.message.attachments?.map((a) => a.name).join(', ')}</p>
        </div>
      )
    case 'message': {
      if (line) {
        return (
          <p className="system-line" data-message-id={item.message.id}>
            {line}
          </p>
        )
      }
      return item.message.role === 'user' ? (
        <div className="sent-message" data-message-id={item.message.id}>
          {(item.message.text || item.message.steered || item.message.attachments?.some((a) => a.kind === 'file')) && <div className={item.message.steered ? 'you steered' : 'you'}>
          {item.message.steered && (
            <span className="steered-label" title="Sent into the running turn">
              steered
            </span>
          )}
          {item.message.attachments?.some((a) => a.kind === 'file') && (
            <ul className="attachments sent">
              {item.message.attachments.map((a, i) => a.kind === 'file' ? (
                <li key={i} className="attachment" title={a.path ?? a.name}>
                  <span className="attachment-name">{a.name}</span>
                </li>
              ) : null)}
            </ul>
          )}
          <Markdown text={item.message.text} breaks />
          </div>}
          {item.message.attachments?.some((a) => a.kind === 'image') && <div className="sent-images">
            {item.message.attachments.map((a, i) =>
              a.kind === 'image' ? <CaptureFigure key={i} message={item.message} image={a} index={i} anchors={pins} /> : null
            )}
          </div>}
          <ForkSummary message={item.message} />
        </div>
      ) : (
        <div className="agent" data-message-id={item.message.id}>
          {renderAgent(item.message)}
        </div>
      )
    }
    case 'plan':
      return <PlanChecklist plan={item.plan} />
    case 'request':
      return <RequestCard request={item.request} />
    case 'notice':
      return item.notice.tone === 'failed' ? (
        <FailedNotice notice={item.notice} />
      ) : (
        <p className="notice">
          {item.notice.text}
        </p>
      )
    default:
      return null
  }
}, sameRow)

type ToolItem = Extract<LogItem, { kind: 'tool' }>

/** Consecutive tool calls become one group (an array); everything else stays as it is. */
function groupTools(items: LogItem[]): (LogItem | ToolItem[])[] {
  const out: (LogItem | ToolItem[])[] = []
  for (const item of items) {
    const last = out.at(-1)
    if (item.kind === 'tool' && Array.isArray(last)) last.push(item)
    else out.push(item.kind === 'tool' ? [item] : item)
  }
  return out
}

/** The agent's own bookkeeping, which the user can't act on: folded into the group's summary. */
const INTERNAL_TOOLS = new Set(['ToolSearch'])

/** One icon per kind of tool call (ACP `ToolKind`). */
const KIND_ICONS: Record<string, LucideIcon> = {
  read: FileText,
  edit: FilePen,
  delete: Trash,
  search: Search,
  execute: Terminal,
  fetch: Globe,
  think: Brain
}

/** A turn's consecutive tool calls in one compact box, internal steps folded into its summary. */
const ToolGroup = memo(function ToolGroup({ tools, reveal }: { tools: ToolItem[]; reveal?: Reveal | null }): React.JSX.Element {
  const [showInternal, setShowInternal] = useState(false)
  const internal = tools.filter((t) => INTERNAL_TOOLS.has(t.toolCall.title))
  const shown = showInternal ? tools : tools.filter((t) => !INTERNAL_TOOLS.has(t.toolCall.title))
  return (
    <div className={shown.length === 0 ? 'tool-group internal-only' : 'tool-group'}>
      {shown.map((t) => (
        <ToolRow key={t.toolCall.id} toolCall={t.toolCall} revealed={reveal?.messageId === `tool:${t.toolCall.id}`} />
      ))}
      {internal.length > 0 && (
        <button className="tool-summary" onClick={() => setShowInternal((s) => !s)} aria-expanded={showInternal}>
          {showInternal ? 'Hide' : 'Show'} {internal.length === 1 ? '1 internal step' : `${internal.length} internal steps`}
        </button>
      )}
    </div>
  )
}, (a, b) => a.reveal === b.reveal && a.tools.length === b.tools.length && a.tools.every((t, i) => t.toolCall === b.tools[i].toolCall))

/** A tool call: one line, expanding to what it did. Collapsed by default. */
const ToolRow = memo(function ToolRow({ toolCall, revealed }: { toolCall: ToolCall; revealed: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => { if (revealed) setOpen(true) }, [revealed])
  const expandable = hasDetails(toolCall)
  const Kind = KIND_ICONS[toolCall.kind ?? ''] ?? Wrench
  // The agent reports a command it is executing as "pending" as well as "in progress".
  const running = toolCall.status === 'pending' || toolCall.status === 'in_progress'
  return (
    <div data-message-id={`tool:${toolCall.id}`} className={`tool status-${toolCall.status}${open ? ' open' : ''}${revealed ? ' revealed' : ''}`}>
      <button
        className="tool-row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
      >
        <Kind className="tool-kind" />
        <span className={toolCall.kind === 'execute' ? 'tool-title command' : 'tool-title'} title={toolCall.title}>
          {toolCall.title}
        </span>
        {running ? (
          <span className="tool-dot" title="Running" />
        ) : toolCall.status === 'failed' || toolCall.status === 'cancelled' ? (
          <span className="tool-failed">
            <CircleAlert />
            {toolCall.status}
          </span>
        ) : (
          <Check className="tool-done" aria-label="Done" />
        )}
        <span className="sr-only">{running ? 'running' : toolCall.status.replace('_', ' ')}</span>
        {expandable && (open ? <ChevronDown className="tool-chevron" /> : <ChevronRight className="tool-chevron" />)}
      </button>
      {open && <ToolDetails toolCall={toolCall} />}
    </div>
  )
})

const PLAN_STATUS = { pending: 'to do', in_progress: 'in progress', completed: 'done' } as const

/** The agent's plan for a turn, as a checklist updated in place (SPEC → Plans). */
function PlanChecklist({ plan }: { plan: Plan }): React.JSX.Element {
  const done = plan.entries.filter((e) => e.status === 'completed').length
  return (
    <section className="plan" aria-label="Plan">
      <div className="plan-head">
        <span className="plan-title">Plan</span>
        <span className="plan-progress">
          {done} of {plan.entries.length} done
        </span>
      </div>
      <ul>
        {plan.entries.map((e, i) => (
          <li key={i} className={`plan-entry ${e.status}`}>
            <span className="plan-box" aria-hidden>
              {e.status === 'completed' && <Check />}
            </span>
            <span className="plan-text">{e.content}</span>
            <span className="sr-only">({PLAN_STATUS[e.status] ?? e.status})</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
