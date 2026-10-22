// The message log shared by the main view and the thread panel.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Message, Plan, ToolCall } from '@shared/types'
import type { OpenSession } from './App'
import { Markdown } from './Markdown'
import { hasDetails, ToolDetails } from './ToolDetails'
import { Brain, Check, ChevronDown, ChevronRight, CircleAlert, FilePen, FileText, Globe, Search, Terminal, Trash, Wrench, type LucideIcon } from 'lucide-react'

/** A transient, client-side note shown in a log (not part of the conversation). */
export type Notice = { id: string; threadId: string | null; text: string; afterSeq: number; tone?: 'failed' }

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

/**
 * A message to scroll to and highlight; `key` repeats it for the same message.
 * With `threadId`, the thread's anchor inside it is the target where it's found.
 */
export type Reveal = { messageId: string; threadId?: string | null; key: number }

type Props = {
  items: LogItem[]
  className: string
  empty: ReactNode
  renderAgent(message: Message): ReactNode
  reveal?: Reveal | null
  /** A user message to show as a status line instead (a review's first pass), or null. */
  systemLine?(message: Message): string | null
}

/** A scrolling log that sticks to the bottom while new output arrives. */
export function Log({ items, className, empty, renderAgent, reveal, systemLine }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  })

  // After the stick-to-bottom scroll above, so it wins.
  useLayoutEffect(() => {
    const message = reveal && ref.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(reveal.messageId)}"]`)
    if (!message) return
    const target =
      (reveal.threadId && message.querySelector<HTMLElement>(`[data-thread="${CSS.escape(reveal.threadId)}"]`)) ||
      (reveal.threadId !== undefined && message.querySelector<HTMLElement>('.anchor-item.active')) ||
      message
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
        {groupTools(items).map((item) => {
          if (Array.isArray(item)) return <ToolGroup key={item[0].toolCall.id} tools={item} reveal={reveal} />
          switch (item.kind) {
            case 'message': {
              const line = item.message.role === 'user' ? systemLine?.(item.message) : null
              if (line) {
                return (
                  <p key={item.message.id} className="system-line" data-message-id={item.message.id}>
                    {line}
                  </p>
                )
              }
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
            }
            case 'plan':
              return <PlanChecklist key={item.plan.id} plan={item.plan} />
            case 'notice':
              return item.notice.tone === 'failed' ? (
                <p key={item.notice.id} className="notice failed" role="alert">
                  <CircleAlert className="notice-icon" aria-hidden />
                  <span>{item.notice.text}</span>
                </p>
              ) : (
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
function ToolGroup({ tools, reveal }: { tools: ToolItem[]; reveal?: Reveal | null }): React.JSX.Element {
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
}

/** A tool call: one line, expanding to what it did. Collapsed by default. */
function ToolRow({ toolCall, revealed }: { toolCall: ToolCall; revealed: boolean }): React.JSX.Element {
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
