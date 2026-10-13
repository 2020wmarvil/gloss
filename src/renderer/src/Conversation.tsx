// The main thread: messages and tool calls with threadId == null.
import { useRef } from 'react'
import type { GitStatus, PullRequest } from '@shared/ipc'
import type { Attachment, Message, MessageQueue, SessionLive, Thread } from '@shared/types'
import type { OpenSession, Panel } from './App'
import type { ListItemSpan } from './anchors'
import { Composer, type ComposerQueue } from './Composer'

import { Log, logItems, type Notice } from './Log'
import { Markdown } from './Markdown'
import { SelectionPopover, type SourceSelection } from './SelectionPopover'
import { resolveSelection } from './source'
import type { Mark } from './sourceSpans'
import { StatusLine } from './StatusLine'

type Props = {
  open: OpenSession
  agentName: string
  live: SessionLive
  git: GitStatus | null
  pr: PullRequest | null
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  notices: Notice[]
  panel: Panel | null
  /** Label of the thread whose turn is running, e.g. "item 2". */
  runningLabel: string | null
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
}

function lastUserMessage(messages: Message[]): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i]
  return undefined
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
      </header>
      <Log
        className="log"
        items={logItems(open, notices, null)}
        empty={<p className="muted">Send a message to start.</p>}
        renderAgent={renderAgent}
      />
      <Composer
        draftKey={session.id}
        className="composer"
        placeholder="Message the agent"
        running={running}
        autoFocus={panel === null}
        primary={panel === null}
        commands={live.commands}
        accepts={live.accepts}
        queue={props.composerQueue}
        onSend={props.onSend}
        onSteer={live.steering && runningThread === null ? props.onSteer : undefined}
        onCancel={props.onCancel}
      />
      <StatusLine
        session={session}
        live={live}
        git={props.git}
        pr={props.pr}
        runningThread={runningThread}
        runningLabel={props.runningLabel}
        steered={running && lastUserMessage(open.messages)?.steered === true}
        queue={props.queue}
        onResumeQueue={() => void props.composerQueue.onResume()}
        onOpenThread={props.onOpenThread}
        onSetChoice={props.onSetChoice}
        onCommand={(text) => props.onSend(text, [])}
      />
      <SelectionPopover scope={mainRef} messages={open.messages} onReply={props.onOpenSelection} />
    </main>
  )
}
