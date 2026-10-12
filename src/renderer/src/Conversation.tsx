// The main thread: messages and tool calls with threadId == null.
import type { Message, Thread } from '@shared/types'
import type { OpenSession, Panel } from './App'
import type { ListItemSpan } from './anchors'
import { Composer } from './Composer'
import { Log, logItems, type Notice } from './Log'
import { Markdown } from './Markdown'

type Props = {
  open: OpenSession
  agentName: string
  /** threadId of the running turn; undefined when idle. */
  runningThread: string | null | undefined
  notices: Notice[]
  panel: Panel | null
  /** Label of the thread whose turn is running, e.g. "item 2". */
  runningLabel: string | null
  onSend(text: string): void
  onCancel(): void
  onOpenItem(message: Message, span: ListItemSpan): void
  onOpenThread(threadId: string): void
}

export function Conversation(props: Props): React.JSX.Element {
  const { open, agentName, runningThread, notices, panel } = props
  const { session } = open
  const running = runningThread !== undefined

  const replyCounts = new Map<string, number>()
  for (const m of open.messages) {
    if (m.threadId !== null) replyCounts.set(m.threadId, (replyCounts.get(m.threadId) ?? 0) + 1)
  }
  const itemThread = (messageId: string, index: number): Thread | undefined =>
    open.threads.find(
      (t) => t.anchorMessageId === messageId && t.anchor.kind === 'listItem' && t.anchor.path[0] === index
    )

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
        items={{
          replyCount: (index) => {
            const t = itemThread(message.id, index)
            return t ? (replyCounts.get(t.id) ?? 0) : 0
          },
          activeIndex,
          runningIndex,
          onOpen: (span) => props.onOpenItem(message, span)
        }}
      />
    )
  }

  return (
    <main className="conversation">
      <header>
        <h1>{session.title}</h1>
        <span className="mono" title={session.cwd}>
          {agentName} · {session.cwd}
        </span>
        {running &&
          (runningThread === null ? (
            <span className="status">Agent is working…</span>
          ) : (
            <button className="status link" onClick={() => props.onOpenThread(runningThread)}>
              Agent is replying in {props.runningLabel ?? 'a thread'}…
            </button>
          ))}
      </header>
      <Log
        className="log"
        items={logItems(open, notices, null)}
        empty={<p className="muted">Send a message to start.</p>}
        renderAgent={renderAgent}
      />
      <Composer
        className="composer"
        placeholder="Message the agent"
        running={running}
        autoFocus={panel === null}
        onSend={props.onSend}
        onCancel={props.onCancel}
      />
    </main>
  )
}
