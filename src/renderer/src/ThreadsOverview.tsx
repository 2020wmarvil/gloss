// The side panel's overview of a session's threads and its queue, and the rail it collapses to
// (SPEC → Conversation view → Side panel).
import { useLayoutEffect, useRef, useState } from 'react'
import type { Message, MessageQueue, Thread } from '@shared/types'
import type { OpenSession } from './App'
import { QueuedRow } from './Composer'
import { errorText } from './errors'
import { ago } from './Sidebar'

export type ThreadSummary = {
  thread: Thread
  replies: number
  /** Its newest message's time, or the thread's creation for messages stored before M9. */
  lastActivity: number
}

/** The session's threads with their reply counts, oldest first. */
export function threadSummaries(open: OpenSession): ThreadSummary[] {
  const byThread = new Map<string, ThreadSummary>(
    open.threads.map((t) => [t.id, { thread: t, replies: 0, lastActivity: t.createdAt }])
  )
  for (const m of open.messages) {
    const s = m.threadId === null ? undefined : byThread.get(m.threadId)
    if (!s) continue
    s.replies++
    if (m.createdAt !== undefined && m.createdAt > s.lastActivity) s.lastActivity = m.createdAt
  }
  return [...byThread.values()].sort((a, b) => a.thread.createdAt - b.thread.createdAt)
}

const threadsIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

/**
 * The collapsed side panel: a threads button with the count and a running dot. `label`
 * says what the count is, when it isn't just threads.
 */
export function SideRail(props: { count: number; running: boolean; label?: string; onExpand(): void }): React.JSX.Element {
  const what = props.label ?? `${props.count} ${props.count === 1 ? 'thread' : 'threads'}`
  return (
    <div className="side-rail">
      <button
        className="rail-button"
        onClick={props.onExpand}
        title={`${what} (Ctrl+Shift+T)`}
        aria-label={`Show ${what}`}
      >
        {threadsIcon}
        <span className="rail-count">{props.count}</span>
        {props.running && <span className="running-dot" aria-label="Running" />}
      </button>
    </div>
  )
}

export type SideTab = 'threads' | 'queue'

type Props = {
  /** Width the user dragged the panel to; null = the CSS default. */
  width: number | null
  open: OpenSession
  tab: SideTab
  onTab(tab: SideTab): void
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  /** The session's queued messages, in the order they will run. */
  queue: MessageQueue
  /** A thread's name, from the start of what it replies to. */
  name(thread: Thread): string
  onOpenThread(threadId: string): void
  /** Scrolls to a sent message and highlights it, opening its thread. */
  onReveal(message: Message): void
  /** Focuses the main conversation's composer, for its queued messages. */
  onOpenMain(): void
  onEditQueued(id: string, text: string): Promise<void>
  onRemoveQueued(id: string): Promise<void>
  onResumeQueue(): Promise<void>
  onCollapse(): void
  /** A review session's Threads tab (SPEC → Review sessions → Side panel), and its count. */
  review?: { content: React.ReactNode; count: number }
}

export function ThreadsOverview(props: Props): React.JSX.Element {
  const { onCollapse, queue } = props
  const summaries = threadSummaries(props.open)
  const [error, setError] = useState<string | null>(null)

  async function queueAction(action: () => Promise<void>): Promise<boolean> {
    setError(null)
    try {
      await action()
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    }
  }

  return (
    <aside
      className="thread-panel threads-overview"
      aria-label="Threads"
      style={props.width === null ? undefined : { flexBasis: props.width }}
    >
      <header>
        <div className="side-tabs" role="tablist">
          <button role="tab" aria-selected={props.tab === 'threads'} onClick={() => props.onTab('threads')}>
            Threads <span className="count">{props.review?.count ?? summaries.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={props.tab === 'queue'}
            onClick={() => props.onTab('queue')}
            title="Queue (Ctrl+Shift+Q)"
          >
            Queue <span className="count">{queue.items.length}</span>
          </button>
        </div>
        <button className="close" onClick={onCollapse} aria-label="Hide panel" title="Hide panel (Ctrl+Shift+T)">
          »
        </button>
      </header>
      {props.tab === 'threads' && props.review ? (
        props.review.content
      ) : props.tab === 'threads' ? (
        <div className="thread-list">
          {summaries.length === 0 && (
            <p className="muted empty">
              No threads yet. Reply to a list item, or select text in an agent message, to start one.
            </p>
          )}
          {summaries.map(({ thread, replies, lastActivity }) => {
            const running = props.runningThread === thread.id
            const queued = queue.items.filter((q) => q.threadId === thread.id).length
            return (
              <button key={thread.id} className="thread-row" onClick={() => props.onOpenThread(thread.id)}>
                <span className="thread-quote">
                  {thread.anchor.kind === 'selection' ? `“${thread.anchor.text}”` : thread.anchor.text}
                </span>
                <span className="thread-meta">
                  <span>
                    {replies} {replies === 1 ? 'reply' : 'replies'}
                  </span>
                  <span title={new Date(lastActivity).toLocaleString()}>
                    {ago(lastActivity) === 'now' ? 'just now' : `${ago(lastActivity)} ago`}
                  </span>
                  {running && (
                    <span className="thread-working">
                      <span className="running-dot" aria-hidden />
                      working
                    </span>
                  )}
                  {queued > 0 && <span className="thread-queued">{queued > 1 ? `${queued} queued` : 'queued'}</span>}
                  {queued > 0 && queue.paused && <span className="thread-paused">paused</span>}
                </span>
              </button>
            )
          })}
        </div>
      ) : (
        <QueueTimeline {...props} queueAction={queueAction} error={error} />
      )}
    </aside>
  )
}

/**
 * The Queue tab: what will run on top (the next message at the bottom of it), then
 * every message sent in the session, newest first, so the turn in progress moves up.
 */
function QueueTimeline(
  props: Props & { queueAction(action: () => Promise<void>): Promise<boolean>; error: string | null }
): React.JSX.Element {
  const { queue, open, queueAction } = props
  const now = useRef<HTMLDivElement>(null)
  const sent = open.messages.filter((m) => m.role === 'user').sort((a, b) => b.seq - a.seq)
  const working = props.runningThread !== undefined ? sent[0] : undefined
  const threadOf = (threadId: string | null): Thread | undefined =>
    threadId === null ? undefined : open.threads.find((t) => t.id === threadId)
  const where = (threadId: string | null): string => {
    const thread = threadOf(threadId)
    return thread ? props.name(thread) : threadId === null ? 'Main conversation' : 'A thread'
  }

  // Opens on the turn in progress, between what waits and what was sent.
  useLayoutEffect(() => {
    now.current?.scrollIntoView?.({ block: 'center' })
  }, [])

  return (
    <div className="thread-list queue-list">
      {queue.items.length === 0 && sent.length === 0 && (
        <p className="muted empty">Nothing sent yet. Messages sent while a turn runs wait here, in the order they will run.</p>
      )}
      {queue.paused && queue.items.length > 0 && (
        <p className="queue-paused">
          Queue paused: the last turn didn&apos;t finish.
          <button onClick={() => void queueAction(props.onResumeQueue)}>Resume</button>
        </p>
      )}
      {props.error && <p className="composer-error">{props.error}</p>}
      {queue.items.length > 0 && (
        <>
          <div className="timeline-label">Queued · next at the bottom</div>
          <ol aria-label="Queued messages">
            {[...queue.items].reverse().map((item) => {
              const thread = threadOf(item.threadId)
              return (
                <QueuedRow
                  key={item.id}
                  item={item}
                  label={
                    <span className="queued-where">
                      <span className="state-dot" data-state={queue.paused ? 'paused' : 'queued'} aria-hidden /> {where(item.threadId)}
                    </span>
                  }
                  onOpen={() => (thread ? props.onOpenThread(thread.id) : props.onOpenMain())}
                  onEdit={(text) => queueAction(() => props.onEditQueued(item.id, text))}
                  onRemove={() => void queueAction(() => props.onRemoveQueued(item.id))}
                />
              )
            })}
          </ol>
        </>
      )}
      <div ref={now} className="timeline-now" aria-hidden />
      {sent.length > 0 && (
        <>
          <div className="timeline-label">Sent · newest first</div>
          <ol aria-label="Sent messages">
            {sent.map((m) => (
              <li key={m.id} className={m === working ? 'sent-row working' : 'sent-row'}>
                <button onClick={() => props.onReveal(m)}>
                  <span className="queued-where">
                    <span className="state-dot" data-state={m === working ? 'working' : m.outcome} aria-hidden />{' '}
                    {where(m.threadId)}
                    {m.createdAt !== undefined && (
                      <span className="sent-when" title={new Date(m.createdAt).toLocaleString()}>
                        {' '}
                        · {ago(m.createdAt) === 'now' ? 'just now' : `${ago(m.createdAt)} ago`}
                      </span>
                    )}
                  </span>
                  <span className="sent-text">{m.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}
