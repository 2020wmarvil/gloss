// The main thread: messages and tool calls with threadId == null.
import { useRef } from 'react'
import type { GitStatus, PullRequest } from '@shared/ipc'
import type { Attachment, Message, MessageQueue, SessionLive, Thread, TurnOutcome } from '@shared/types'
import type { OpenSession, Panel } from './App'
import type { ListItemSpan } from './anchors'
import { Composer, type ComposerQueue } from './Composer'

import { Log, logItems, type Notice, type Reveal } from './Log'
import { Markdown } from './Markdown'
import { SelectionPopover, type SourceSelection } from './SelectionPopover'
import { resolveSelection } from './source'
import type { Mark } from './sourceSpans'
import { StatusLine } from './StatusLine'

type Props = {
  open: OpenSession
  listItemReplies: boolean
  agentName: string
  live: SessionLive
  /** Messages sent in every session, newest first, for the composer's Up and Down. */
  history: string[]
  git: GitStatus | null
  pr: PullRequest | null
  obsidianVault?: string
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  notices: Notice[]
  panel: Panel | null
  reveal: Reveal | null
  /** The thread the agent works in, or last worked in, for the activity strip; null if none ever did. */
  lastThread: StripThread | null
  /** The whole session's queue, for the status line. */
  queue: MessageQueue
  /** The main thread's part of it, for the composer. */
  composerQueue: ComposerQueue
  onSend(text: string, attachments: Attachment[]): void
  /** Injects the message into the running turn (when it runs in the main thread). */
  onSteer(text: string, attachments: Attachment[]): void
  onCancel(): void
  onSetChoice(kind: 'model' | 'effort', value: string): Promise<void>
  onOpenItem(message: Message, span: ListItemSpan): void
  onOpenSelection(message: Message, selection: SourceSelection): void
  onOpenThread(threadId: string): void
  /** Opens the side panel's Queue tab. */
  onOpenQueue(): void
  onHandoff?(): void
  onOpenSource?(): void
}

export function Conversation(props: Props): React.JSX.Element {
  const { open, agentName, live, runningThread, notices, panel } = props
  const { session } = open
  const running = runningThread !== undefined
  const mainRef = useRef<HTMLElement>(null)

  const replyCounts = new Map<string, number>()
  for (const m of open.messages) {
    if (m.threadId !== null) replyCounts.set(m.threadId, (replyCounts.get(m.threadId) ?? 0) + 1)
  }
  const itemThread = (messageId: string, index: number): Thread | undefined =>
    open.threads.find(
      (t) => t.anchorMessageId === messageId && t.anchor.kind === 'listItem' && t.anchor.path[0] === index
    )

  /** Selection anchors in a message, re-found by text if their offsets no longer match. */
  function marksFor(message: Message): Mark[] {
    const marks: Mark[] = []
    for (const t of open.threads) {
      if (t.anchorMessageId !== message.id || t.anchor.kind !== 'selection') continue
      const r = resolveSelection(message.text, t.anchor)
      if (r) {
        marks.push({
          ...r,
          threadId: t.id,
          title: t.anchor.text,
          ...(panel?.threadId === t.id ? { className: 'active' } : {})
        })
      }
    }
    if (panel && panel.threadId === null && panel.anchorMessageId === message.id && panel.anchor.kind === 'selection') {
      marks.push({ start: panel.anchor.start, end: panel.anchor.end, threadId: null })
    }
    return marks
  }

  function renderAgent(message: Message): React.JSX.Element {
    const activeIndex =
      panel?.anchorMessageId === message.id && panel.anchor.kind === 'listItem'
        ? panel.anchor.path[0]
        : null
    const runningThreadRow = open.threads.find((t) => t.id === runningThread)
    const runningIndex =
      runningThreadRow?.anchorMessageId === message.id && runningThreadRow.anchor.kind === 'listItem'
        ? runningThreadRow.anchor.path[0]
        : null
    return (
      <Markdown
        text={message.text}
        listItemReplies={props.listItemReplies}
        anchors={{
          replyCount: (index) => {
            const t = itemThread(message.id, index)
            return t ? (replyCounts.get(t.id) ?? 0) : 0
          },
          activeIndex,
          runningIndex,
          onOpenItem: (span) => props.onOpenItem(message, span),
          marks: marksFor(message),
          threadCount: (threadId) => replyCounts.get(threadId) ?? 0,
          runningThread: runningThread ?? null,
          onOpenThread: props.onOpenThread
        }}
      />
    )
  }

  return (
    <main className="conversation" ref={mainRef}>
      <header>
        <h1 title={session.title}>{session.title}</h1>
        <span className="mono">{agentName}</span>
        {props.onHandoff && <button onClick={props.onHandoff} disabled={running} title="Continue this conversation with another agent">Continue with...</button>}
      </header>
      {session.handoff && <div className="handoff-source">
        <span title={session.handoff.quote ?? session.handoff.title}>Continued from {session.handoff.title}{session.handoff.quote ? ` / "${session.handoff.quote}"` : ''} ({session.handoff.agentId})</span>
        <button onClick={props.onOpenSource}>Open source</button>
      </div>}
      <Log
        className="log"
        items={logItems(open, notices, null)}
        empty={<p className="muted">Send a message to start.</p>}
        renderAgent={renderAgent}
        reveal={props.reveal}
      />
      <ActivityStrip
        thread={props.lastThread}
        queued={props.queue.items.length}
        onOpenThread={props.onOpenThread}
        onOpenQueue={props.onOpenQueue}
      />
      <Composer
        draftKey={session.id}
        className="composer"
        placeholder="Message the agent"
        running={running}
        autoFocus={panel === null}
        primary={panel === null}
        main
        commands={live.commands}
        accepts={live.accepts}
        history={props.history}
        queue={props.composerQueue}
        onSend={props.onSend}
        onSteer={live.steering && runningThread === null ? props.onSteer : undefined}
        onCancel={runningThread === null ? props.onCancel : undefined}
      />
      <StatusLine
        obsidianVault={props.obsidianVault}
        session={session}
        live={live}
        git={props.git}
        pr={props.pr}
        running={running}
        queue={props.queue}
        onResumeQueue={() => void props.composerQueue.onResume()}
        onSetChoice={props.onSetChoice}
        onCommand={(text) => props.onSend(text, [])}
      />
      <SelectionPopover scope={mainRef} messages={open.messages} onReply={props.onOpenSelection} />
    </main>
  )
}

/** The strip's thread, and the state of its latest turn (null: Gloss didn't see it end). */
export type StripThread = { id: string; name: string; state: 'working' | TurnOutcome | null }

const STRIP_VERB = {
  working: 'Working in',
  completed: 'Done in',
  cancelled: 'Cancelled in',
  failed: 'Failed in',
  unknown: 'Last worked in'
} as const

/**
 * Above the composer once a thread has had a turn: the thread the agent works in, or
 * last worked in, and what is queued. It stays put rather than coming and going.
 */
function ActivityStrip(props: {
  thread: StripThread | null
  queued: number
  onOpenThread(threadId: string): void
  onOpenQueue(): void
}): React.JSX.Element | null {
  const { thread, queued } = props
  if (thread === null && queued === 0) return null
  return (
    <div className="activity-strip" role="status">
      {thread !== null && (
        <button className="activity-thread" onClick={() => props.onOpenThread(thread.id)} title="Open the thread">
          <span className="state-dot" data-state={thread.state ?? undefined} aria-hidden />
          <span className="activity-name">
            {STRIP_VERB[thread.state ?? 'unknown']} “{thread.name}”
          </span>
        </button>
      )}
      {queued > 0 && (
        <button className="activity-queued" onClick={props.onOpenQueue} title="Show the queue (Ctrl+Shift+Q)">
          {queued} queued
        </button>
      )}
    </div>
  )
}
