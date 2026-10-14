// The message log shared by the main view and the thread panel.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Message, Plan, ToolCall } from '@shared/types'
import type { OpenSession } from './App'
import { Markdown } from './Markdown'
import { hasDetails, ToolDetails } from './ToolDetails'

/** A transient, client-side note shown in a log (not part of the conversation). */
export type Notice = { id: string; threadId: string | null; text: string; afterSeq: number }

export type LogItem =
  | { kind: 'message'; seq: number; message: Message }
  | { kind: 'tool'; seq: number; toolCall: ToolCall }
  | { kind: 'plan'; seq: number; plan: Plan }
  | { kind: 'notice'; seq: number; notice: Notice }

/** Messages, tool calls, plans and notices of one thread (null = main), in seq order. */
export function logItems(open: OpenSession, notices: Notice[], threadId: string | null): LogItem[] {
  return [
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
      .map((n): LogItem => ({ kind: 'notice', seq: n.afterSeq + 0.5, notice: n }))
  ].sort((a, b) => a.seq - b.seq)
}

/** A message to scroll to and highlight; `key` repeats it for the same message. */
export type Reveal = { messageId: string; key: number }

type Props = {
  items: LogItem[]
  className: string
  empty: ReactNode
  renderAgent(message: Message): ReactNode
  reveal?: Reveal | null
}

/** A scrolling log that sticks to the bottom while new output arrives. */
export function Log({ items, className, empty, renderAgent, reveal }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  })

  // After the stick-to-bottom scroll above, so it wins.
  useLayoutEffect(() => {
    const target = reveal && ref.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(reveal.messageId)}"]`)
    if (!target) return
    stickToBottom.current = false
    target.scrollIntoView?.({ block: 'center' })
    target.classList.remove('revealed')
    void target.offsetWidth // restarts the highlight animation
    target.classList.add('revealed')
  }, [reveal])

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
                <div
                  key={item.message.id}
                  className={item.message.steered ? 'you steered' : 'you'}
                  data-message-id={item.message.id}
                >
                  {item.message.steered && (
                    <span className="steered-label" title="Sent into the running turn">
                      steered
                    </span>
                  )}
                  {item.message.attachments && item.message.attachments.length > 0 && (
                    <ul className="attachments sent">
                      {item.message.attachments.map((a, i) => (
                        <li key={i} className="attachment" title={a.kind === 'file' ? (a.path ?? a.name) : a.name}>
                          {a.kind === 'image' ? (
                            <img src={`data:${a.mimeType};base64,${a.data}`} alt={a.name} />
                          ) : (
                            <span className="attachment-name">{a.name}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Markdown text={item.message.text} breaks />
                </div>
              ) : (
                <div key={item.message.id} className="agent" data-message-id={item.message.id}>
                  {renderAgent(item.message)}
                </div>
              )
            case 'tool':
              return <ToolRow key={item.toolCall.id} toolCall={item.toolCall} />
            case 'plan':
              return <PlanChecklist key={item.plan.id} plan={item.plan} />
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

/** A tool call: one line, expanding to what it did. Collapsed by default. */
function ToolRow({ toolCall }: { toolCall: ToolCall }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = hasDetails(toolCall)
  return (
    <div className={`tool status-${toolCall.status}${open ? ' open' : ''}`}>
      <button
        className="tool-row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tool-dot" aria-hidden />
        <span className="tool-title">{toolCall.title}</span>
        <span className="tool-status">{toolCall.status.replace('_', ' ')}</span>
        {expandable && (
          <span className="tool-chevron" aria-hidden>
            {open ? '▾' : '▸'}
          </span>
        )}
      </button>
      {open && <ToolDetails toolCall={toolCall} />}
    </div>
  )
}

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
            <span className="plan-box" aria-hidden />
            <span className="plan-text">{e.content}</span>
            <span className="sr-only">({PLAN_STATUS[e.status] ?? e.status})</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
