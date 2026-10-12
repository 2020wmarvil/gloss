// The message log shared by the main view and the thread panel.
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { Message, ToolCall } from '@shared/types'
import type { OpenSession } from './App'

/** A transient, client-side note shown in a log (not part of the conversation). */
export type Notice = { id: string; threadId: string | null; text: string; afterSeq: number }

export type LogItem =
  | { kind: 'message'; seq: number; message: Message }
  | { kind: 'tool'; seq: number; toolCall: ToolCall }
  | { kind: 'notice'; seq: number; notice: Notice }

/** Messages, tool calls and notices of one thread (null = main), in seq order. */
export function logItems(open: OpenSession, notices: Notice[], threadId: string | null): LogItem[] {
  return [
    ...open.messages
      .filter((m) => m.threadId === threadId)
      .map((m): LogItem => ({ kind: 'message', seq: m.seq, message: m })),
    ...open.toolCalls
      .filter((t) => t.threadId === threadId)
      .map((t): LogItem => ({ kind: 'tool', seq: t.messageSeq, toolCall: t })),
    ...notices
      .filter((n) => n.threadId === threadId)
      .map((n): LogItem => ({ kind: 'notice', seq: n.afterSeq + 0.5, notice: n }))
  ].sort((a, b) => a.seq - b.seq)
}

type Props = {
  items: LogItem[]
  className: string
  empty: ReactNode
  renderAgent(message: Message): ReactNode
}

/** A scrolling log that sticks to the bottom while new output arrives. */
export function Log({ items, className, empty, renderAgent }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  })

  return (
    <div
      className="log-scroll"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
      }}
    >
      <div className={className}>
        {items.length === 0 && empty}
        {items.map((item) => {
          switch (item.kind) {
            case 'message':
              return item.message.role === 'user' ? (
                <div key={item.message.id} className="you">
                  {item.message.text}
                </div>
              ) : (
                <div key={item.message.id} className="agent" data-message-id={item.message.id}>
                  {renderAgent(item.message)}
                </div>
              )
            case 'tool':
              return <ToolRow key={item.toolCall.id} toolCall={item.toolCall} />
            case 'notice':
              return (
                <p key={item.notice.id} className="notice">
                  {item.notice.text}
                </p>
              )
          }
        })}
      </div>
    </div>
  )
}

function ToolRow({ toolCall }: { toolCall: ToolCall }): React.JSX.Element {
  return (
    <div className={`tool status-${toolCall.status}`}>
      <span className="tool-dot" aria-hidden />
      <span className="tool-title">{toolCall.title}</span>
      <span className="tool-status">{toolCall.status.replace('_', ' ')}</span>
    </div>
  )
}
