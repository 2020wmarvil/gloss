import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Message, ToolCall } from '@shared/types'
import type { OpenSession } from './App'
import { Markdown } from './Markdown'

/** A transient, client-side note shown in the log (not part of the conversation). */
export type Notice = { id: string; text: string; afterSeq: number }

type Item =
  | { kind: 'message'; seq: number; message: Message }
  | { kind: 'tool'; seq: number; toolCall: ToolCall }
  | { kind: 'notice'; seq: number; notice: Notice }

type Props = {
  open: OpenSession
  agentName: string
  running: boolean
  notices: Notice[]
  onSend(text: string): void
  onCancel(): void
}

export function Conversation({ open, agentName, running, notices, onSend, onCancel }: Props): React.JSX.Element {
  const { session } = open
  // Main thread only: threadId == null.
  const items: Item[] = [
    ...open.messages
      .filter((m) => m.threadId === null)
      .map((m): Item => ({ kind: 'message', seq: m.seq, message: m })),
    ...open.toolCalls
      .filter((t) => t.threadId === null)
      .map((t): Item => ({ kind: 'tool', seq: t.messageSeq, toolCall: t })),
    ...notices.map((n): Item => ({ kind: 'notice', seq: n.afterSeq + 0.5, notice: n }))
  ].sort((a, b) => a.seq - b.seq)

  const logRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  useLayoutEffect(() => {
    const el = logRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  })

  return (
    <main className="conversation">
      <header>
        <h1>{session.title}</h1>
        <span className="mono" title={session.cwd}>
          {agentName} · {session.cwd}
        </span>
        {running && <span className="status">Agent is working…</span>}
      </header>
      <div
        className="log-scroll"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        <div className="log">
          {items.length === 0 && <p className="muted">Send a message to start.</p>}
          {items.map((item) => {
            switch (item.kind) {
              case 'message':
                return item.message.role === 'user' ? (
                  <div key={item.message.id} className="you">
                    {item.message.text}
                  </div>
                ) : (
                  <div key={item.message.id} className="agent">
                    <Markdown text={item.message.text} />
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
      <Composer running={running} onSend={onSend} onCancel={onCancel} />
    </main>
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

function Composer({
  running,
  onSend,
  onCancel
}: {
  running: boolean
  onSend(text: string): void
  onCancel(): void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!running) ref.current?.focus()
  }, [running])

  function submit(): void {
    const trimmed = text.trim()
    if (!trimmed || running) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="composer">
      <div className="box">
        <textarea
          ref={ref}
          rows={Math.min(8, Math.max(1, text.split('\n').length))}
          placeholder="Message the agent"
          aria-label="Message the agent"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {running ? (
          <button className="cancel" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button className="primary send" onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
