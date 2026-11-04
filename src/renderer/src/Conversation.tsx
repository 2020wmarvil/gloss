// The main thread: messages and tool calls with threadId == null.
import { useMemo, useRef } from 'react'
import { Clock } from 'lucide-react'
import { folderName } from '@shared/paths'
import { projectOf } from '@shared/worktree'
import type { GitStatus, PullRequest } from '@shared/ipc'
import type { Attachment, Message, MessageQueue, SessionLive, Thread, TurnOutcome } from '@shared/types'
import type { OpenSession, Panel } from './App'
import type { ListItemSpan } from './anchors'
import { Composer, type ComposerQueue } from './Composer'
import { pinAnchorsFor } from './CaptureFigure'

import { Log, logItems, type Notice, type Reveal } from './Log'
import { Markdown } from './Markdown'
import { SelectionMenu, type SourceSelection } from './SelectionMenu'
import { resolveSelection } from './source'
import type { Mark } from './sourceSpans'
import { StatusLine } from './StatusLine'

type Props = {
  open: OpenSession
  agentName: string
  live: SessionLive
  /** Messages sent in every session, newest first, for the composer's Up and Down. */
  history: string[]
  git: GitStatus | null
  pr: PullRequest | null
  obsidianVault?: string
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  /** The threads with a running turn: the session's, and its fork threads'. */
  busyThreads: string[]
  notices: Notice[]
  panel: Panel | null
  reveal: Reveal | null
  /** Where the agent works, or last worked, for the activity strip; null if it never did. */
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
  /** `fork`: a new thread runs in a fork of the session (SPEC → Fork threads). */
  onOpenSelection(message: Message, selection: SourceSelection, fork: boolean): void
  /** Why the agent can't fork its sessions, if it can't. */
  forkDisabled?: string
  /** Opens the thread on a pin of an annotated screenshot (SPEC → Visual feedback). */
  onOpenPin(message: Message, image: number, pin: number): void
  onOpenThread(threadId: string): void
  /** Focuses the main composer. */
  onOpenMain(): void
  /** Opens the side panel's Queue tab. */
  onOpenQueue(): void
  /** Pop out, or Return to main window, at the header's end (SPEC → Session windows). */
  windowButton?: React.ReactNode
  /** **Review changes**, before it (SPEC → Worktrees → Reviews). */
  reviewButton?: React.ReactNode
}

export function Conversation(props: Props): React.JSX.Element {
  const { open, agentName, live, runningThread, notices, panel } = props
  const { session } = open
  const running = runningThread !== undefined
  const mainRef = useRef<HTMLElement>(null)
  const items = useMemo(() => logItems(open, notices, null), [open.messages, open.toolCalls, open.plans, open.threads, open.requests, notices])

  const replyCounts = new Map<string, number>()
  for (const m of open.messages) {
    if (m.threadId !== null) replyCounts.set(m.threadId, (replyCounts.get(m.threadId) ?? 0) + 1)
  }
  /** Each message's threads (anchored in it). */
  const anchoredIn = useMemo(() => {
    const map = new Map<string, Thread[]>()
    for (const t of open.threads) if (t.anchorMessageId !== null) map.set(t.anchorMessageId, [...(map.get(t.anchorMessageId) ?? []), t])
    return map
  }, [open.threads])
  const itemThread = (messageId: string, index: number): Thread | undefined =>
    anchoredIn.get(messageId)?.find((t) => t.anchor.kind === 'listItem' && t.anchor.path[0] === index)

  // Rows that aren't rendered again keep their handlers: these always call the latest props.
  const latest = useRef(props)
  latest.current = props
  const actions = useMemo(() => ({
    openItem: (message: Message, span: ListItemSpan) => latest.current.onOpenItem(message, span),
    openThread: (threadId: string) => latest.current.onOpenThread(threadId),
    openPin: (message: Message, image: number, pin: number) => latest.current.onOpenPin(message, image, pin)
  }), [])

  /** Everything a message's row shows besides the message: its threads' replies and state, and the panel's anchor in it. */
  function version(message: Message): string {
    const parts = (anchoredIn.get(message.id) ?? []).map((t) =>
      `${t.id}:${replyCounts.get(t.id) ?? 0}:${props.busyThreads.includes(t.id) ? 1 : 0}:${panel?.threadId === t.id ? 1 : 0}`
    )
    if (panel?.anchorMessageId === message.id) parts.push(JSON.stringify([panel.threadId, panel.anchor]))
    return parts.join('|')
  }

  /** Selection anchors in a message, re-found by text if their offsets no longer match. */
  function marksFor(message: Message): Mark[] {
    const marks: Mark[] = []
    for (const t of anchoredIn.get(message.id) ?? []) {
      if (t.anchor.kind !== 'selection') continue
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
    const runningIndexes = (anchoredIn.get(message.id) ?? []).flatMap((t) =>
      props.busyThreads.includes(t.id) && t.anchor.kind === 'listItem' ? [t.anchor.path[0]] : []
    )
    return (
      <Markdown
        text={message.text}
        anchors={{
          replyCount: (index) => {
            const t = itemThread(message.id, index)
            return t ? (replyCounts.get(t.id) ?? 0) : 0
          },
          activeIndex,
          runningIndexes,
          onOpenItem: (span) => actions.openItem(message, span),
          marks: marksFor(message),
          threadCount: (threadId) => replyCounts.get(threadId) ?? 0,
          running: props.busyThreads,
          onOpenThread: actions.openThread
        }}
      />
    )
  }

  return (
    <main className="conversation" ref={mainRef}>
      <header>
        <h1 title={session.title}>{session.title}</h1>
        <span className="agent-name">{agentName}</span>
        <span className="header-tools">
          {props.reviewButton}
          {props.windowButton}
        </span>
      </header>
      <Log
        cwd={open.session.cwd}
        className="log"
        scrollKey={`${open.session.id}:main`}
        items={items}
        empty={<h2 className="new-hint">What should {agentName} do in {folderName(projectOf(session))}?</h2>}
        renderAgent={renderAgent}
        version={version}
        reveal={props.reveal}
        pins={pinAnchorsFor(open, panel, props.busyThreads, actions.openPin)}
        footer={<>
          <ActivityStrip
            thread={props.lastThread}
            queued={props.queue.items.length}
            onOpenThread={props.onOpenThread}
            onOpenMain={() => {
              const log = mainRef.current?.querySelector('.log-scroll')
              log?.scrollTo?.({ top: log.scrollHeight, behavior: 'smooth' })
              props.onOpenMain()
            }}
            onOpenQueue={props.onOpenQueue}
          />
          <Composer
            sessionId={open.session.id}
            agent={{ id: open.session.agentId, name: agentName }}
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
            onInterrupt={props.onCancel}
            onCancel={runningThread === null ? props.onCancel : undefined}
          />
          <StatusLine
            obsidianVault={props.obsidianVault}
            session={session}
            live={live}
            git={props.git}
            pr={props.pr}
            running={running}
            waiting={open.requests?.length}
            queue={props.queue}
            queueShownAbove
            onResumeQueue={() => void props.composerQueue.onResume()}
            onSetChoice={props.onSetChoice}
            onCommand={(text) => props.onSend(text, [])}
          />
        </>}
      />
      <SelectionMenu scope={mainRef} messages={open.messages} onReply={props.onOpenSelection} forkDisabled={props.forkDisabled} />
    </main>
  )
}

/**
 * The strip's thread (id null: the main conversation), and the state of its latest turn
 * (null: Gloss didn't see it end).
 */
export type StripThread = { id: string | null; name: string; state: 'working' | 'waiting' | TurnOutcome | null }

const STRIP_VERB = {
  working: 'Working in',
  waiting: 'Waiting for you in',
  completed: 'Done in',
  cancelled: 'Cancelled in',
  failed: 'Failed in',
  unknown: 'Last worked in'
} as const

/**
 * Above the composer once a turn has run: the thread (or the main conversation) the agent
 * works in, or last worked in, and what is queued. It stays put rather than coming and going.
 */
function ActivityStrip(props: {
  thread: StripThread | null
  queued: number
  onOpenThread(threadId: string): void
  onOpenMain(): void
  onOpenQueue(): void
}): React.JSX.Element | null {
  const { thread, queued } = props
  if (thread === null && queued === 0) return null
  return (
    <div className="activity-strip" role="status">
      <div className="activity-card">
        {thread !== null ? (
          <button
            className="activity-thread"
            onClick={() => (thread.id === null ? props.onOpenMain() : props.onOpenThread(thread.id))}
            title={thread.id === null ? 'Go to the latest message' : 'Open the thread'}
          >
            <span className="state-dot" data-state={thread.state ?? undefined} aria-hidden />
            <span className="activity-name">
              {STRIP_VERB[thread.state ?? 'unknown']} {thread.id === null ? thread.name : `“${thread.name}”`}
            </span>
          </button>
        ) : (
          <span className="activity-thread" />
        )}
        {queued > 0 && (
          <button className="ghost sm activity-queued" onClick={props.onOpenQueue} title="Show the queue (Ctrl+Shift+Q)">
            <Clock />
            {queued} queued
          </button>
        )}
      </div>
    </div>
  )
}
