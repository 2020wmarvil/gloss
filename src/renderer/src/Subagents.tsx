// Sub-agents (SPEC → Sub-agents): a card in the log for each one, its feed in the side panel,
// and a status line chip counting the latest turn's.
import { createContext, useContext, useEffect, useState } from 'react'
import type { Message, Subagent, SubagentFeedItem, ToolCall } from '@shared/types'
import {
  formatDuration,
  isSubagentRunning,
  subagentDuration,
  subagentOf,
  subagentToolCount
} from '@shared/subagents'
import { ArrowLeft, Bot, Check, ChevronRight, CircleAlert, Locate, PanelRight, Square } from 'lucide-react'
import { Markdown } from './Markdown'
import { Popover } from './Popover'
import { ToolRow } from './Log'

/** What a card can do, given by the session's view. */
export type SubagentActions = {
  /** Opens its feed in the side panel. */
  open(launchId: string): void
  stop(launchId: string): void
  /** Scrolls the conversation to its card. */
  find(toolCall: ToolCall): void
}

export const SubagentContext = createContext<SubagentActions | null>(null)

/** The current time, ticking each second while `active`: for running sub-agents' durations. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** "Explore · 14 tools · 1m 05s". */
function stats(s: Subagent, now: number): string {
  const tools = subagentToolCount(s)
  const duration = subagentDuration(s, now)
  return [s.role, `${tools} ${tools === 1 ? 'tool' : 'tools'}`, duration !== null ? formatDuration(duration) : null]
    .filter(Boolean)
    .join(' · ')
}

function StateIcon({ s }: { s: Subagent }): React.JSX.Element {
  if (isSubagentRunning(s)) return <span className="tool-dot" title={s.state === 'requires_action' ? 'Waiting for you' : 'Running'} />
  if (s.stopReason === 'cancelled' || s.stopReason === 'error' || s.stopReason === 'refusal') {
    return <CircleAlert className="subagent-failed" aria-label={s.stopReason === 'cancelled' ? 'Stopped' : 'Failed'} />
  }
  return <Check className="tool-done" aria-label="Done" />
}

function endLabel(s: Subagent): string | null {
  if (isSubagentRunning(s)) return s.state === 'requires_action' ? 'Waiting for you' : null
  if (s.stopReason === 'cancelled') return 'Stopped'
  if (s.stopReason === 'error') return s.error ? `Failed: ${s.error}` : 'Failed'
  return null
}

/** A sub-agent in the log: its title, and how much it did. Opens its feed. */
export function SubagentCard({ toolCall }: { toolCall: ToolCall }): React.JSX.Element | null {
  const actions = useContext(SubagentContext)
  const s = subagentOf(toolCall)
  const running = s ? isSubagentRunning(s) : false
  const now = useNow(running)
  if (!s) return null
  return (
    <div className={`subagent-card${running ? ' running' : ''}`} data-message-id={`tool:${toolCall.id}`}>
      <button className="subagent-open" onClick={() => actions?.open(toolCall.id)} title="Show what it did">
        <span className="subagent-head">
          <Bot className="tool-kind" aria-hidden />
          <span className="subagent-title" title={toolCall.title}>{toolCall.title}</span>
          <StateIcon s={s} />
          <ChevronRight className="tool-chevron" aria-hidden />
        </span>
        <span className="subagent-line">{stats(s, now)}</span>
      </button>
    </div>
  )
}

/** The session's sub-agents, newest first, for the side panel's Sub-agents tab. */
export function sessionSubagents(toolCalls: ToolCall[]): { toolCall: ToolCall; subagent: Subagent }[] {
  const out: { toolCall: ToolCall; subagent: Subagent }[] = []
  for (const t of toolCalls) {
    const s = subagentOf(t)
    if (s) out.push({ toolCall: t, subagent: s })
  }
  return out.sort((a, b) => b.toolCall.messageSeq - a.toolCall.messageSeq)
}

/** The Sub-agents tab: every sub-agent of the session, newest first. */
export function SubagentList({ toolCalls }: { toolCalls: ToolCall[] }): React.JSX.Element {
  const actions = useContext(SubagentContext)
  const list = sessionSubagents(toolCalls)
  const now = useNow(list.some((x) => isSubagentRunning(x.subagent)))
  return (
    <div className="thread-list subagent-tab">
      {list.length === 0 && (
        <p className="muted empty">No sub-agents yet. When the agent delegates work to sub-agents, each one shows here with what it is doing.</p>
      )}
      {list.map(({ toolCall, subagent: s }) => {
        const running = isSubagentRunning(s)
        return (
          <div key={toolCall.id} className="thread-row subagent-row">
            <button className="thread-open" onClick={() => actions?.open(toolCall.id)} title="Show what it did">
              <span className="subagent-head">
                <StateIcon s={s} />
                <span className="subagent-title" title={toolCall.title}>{toolCall.title}</span>
              </span>
              <span className="thread-meta">{stats(s, now)}</span>
            </button>
            {/* On hover, as a thread row's Find in main; in the same order as the panel's header. */}
            <span className="subagent-row-actions">
              {actions && (
                <button className="ghost sm icon thread-find subagent-find" onClick={() => actions.find(toolCall)} title="Find in main session" aria-label="Find in main session">
                  <Locate />
                </button>
              )}
              {running && actions && (
                <button className="ghost sm icon subagent-stop" onClick={() => actions.stop(toolCall.id)} title="Stop this sub-agent" aria-label={`Stop ${toolCall.title}`}>
                  <Square />
                </button>
              )}
            </span>
          </div>
        )
      })}
    </div>
  )
}


/** A feed's items, consecutive tool calls in one box as in the log. */
function groupFeed(feed: SubagentFeedItem[]): (Extract<SubagentFeedItem, { type: 'text' }> | Extract<SubagentFeedItem, { type: 'tool' }>[])[] {
  const out: (Extract<SubagentFeedItem, { type: 'text' }> | Extract<SubagentFeedItem, { type: 'tool' }>[])[] = []
  for (const item of feed) {
    const last = out.at(-1)
    if (item.type === 'tool' && Array.isArray(last)) last.push(item)
    else out.push(item.type === 'tool' ? [item] : item)
  }
  return out
}

function asToolCall(item: Extract<SubagentFeedItem, { type: 'tool' }>, parent: ToolCall): ToolCall {
  return {
    id: item.id,
    sessionId: parent.sessionId,
    messageSeq: parent.messageSeq,
    threadId: parent.threadId,
    title: item.title,
    status: item.status,
    ...(item.kind ? { kind: item.kind } : {}),
    ...(item.content !== undefined ? { content: item.content } : {})
  }
}

/** A sub-agent's feed in the side panel: its task, what it said and did, and its answer. */
export function SubagentPanel(props: {
  toolCall: ToolCall
  width: number | null
  backLabel: string
  onBack(): void
  onClose(): void
  onFindInMain(): void
}): React.JSX.Element | null {
  const actions = useContext(SubagentContext)
  const { toolCall } = props
  const s = subagentOf(toolCall)
  const running = s ? isSubagentRunning(s) : false
  const now = useNow(running)
  if (!s) return null
  const ended = endLabel(s)
  // The answer is usually its last words, already in the feed.
  const lastText = s.feed.findLast((i) => i.type === 'text')
  const replyShown = !!s.reply && !running && (lastText?.type !== 'text' || lastText.text.trim() !== s.reply.trim())
  return (
    <aside className="thread-panel subagent-panel" aria-label="Sub-agent" style={props.width === null ? undefined : { flexBasis: props.width }}>
      <header>
        <button className="back" onClick={props.onBack}>
          <ArrowLeft />
          {props.backLabel}
        </button>
        <h2 className="thread-label" title={toolCall.title}>{toolCall.title}</h2>
        <button className="header-button icon find-in-main" onClick={props.onFindInMain} title="Find in main session" aria-label="Find in main session">
          <Locate />
        </button>
        {running && actions && (
          <button className="header-button icon subagent-stop" onClick={() => actions.stop(toolCall.id)} title="Stop this sub-agent" aria-label="Stop this sub-agent">
            <Square />
          </button>
        )}
        <button className="close" onClick={props.onClose} aria-label="Hide panel" title="Hide panel (Ctrl+Shift+T)">
          <PanelRight />
        </button>
      </header>
      <div className="subagent-summary">
        <StateIcon s={s} />
        <span>{stats(s, now)}</span>
        {ended && <span className="subagent-ended">{ended}</span>}
      </div>
      {s.prompt && (
        <blockquote className="anchor-quote subagent-prompt" title="What it was asked to do">
          <Markdown text={s.prompt} />
        </blockquote>
      )}
      <div className="thread-log subagent-feed">
        {s.feed.length === 0 && <p className="muted empty">{running ? 'Starting…' : 'Nothing to show. Gloss keeps what a sub-agent did only for sessions run with it.'}</p>}
        {groupFeed(s.feed).map((item) =>
          Array.isArray(item) ? (
            <div key={item[0].id} className="tool-group">
              {item.map((t) => <ToolRow key={t.id} toolCall={asToolCall(t, toolCall)} revealed={false} />)}
            </div>
          ) : (
            <div key={`text:${item.id}:${s.feed.indexOf(item)}`} className="agent">
              <Markdown text={item.text} />
            </div>
          )
        )}
        {replyShown && s.reply && (
          <section className="subagent-reply" aria-label="Its answer">
            <h3>Answer sent to the main conversation</h3>
            <Markdown text={s.reply} />
          </section>
        )}
      </div>
    </aside>
  )
}

/**
 * The latest turn's sub-agents: the ones after the session's latest user message, or still
 * running. Oldest first.
 */
export function latestSubagents(messages: Message[], toolCalls: ToolCall[]): { toolCall: ToolCall; subagent: Subagent }[] {
  let lastUser = -1
  for (const m of messages) if (m.role === 'user' && m.seq > lastUser) lastUser = m.seq
  const out: { toolCall: ToolCall; subagent: Subagent }[] = []
  for (const t of toolCalls) {
    const s = subagentOf(t)
    if (s && (t.messageSeq > lastUser || isSubagentRunning(s))) out.push({ toolCall: t, subagent: s })
  }
  return out.sort((a, b) => a.toolCall.messageSeq - b.toolCall.messageSeq)
}

/** "3 running · 6 done" in the status line, opening the list with a stop for each. */
export function SubagentChip({ messages, toolCalls }: { messages: Message[]; toolCalls: ToolCall[] }): React.JSX.Element | null {
  const actions = useContext(SubagentContext)
  const list = latestSubagents(messages, toolCalls)
  const running = list.filter((x) => isSubagentRunning(x.subagent)).length
  const now = useNow(running > 0)
  if (list.length === 0) return null
  const done = list.length - running
  const tools = list.reduce((n, x) => n + subagentToolCount(x.subagent), 0)
  const label = (
    <>
      <Bot className="status-icon" aria-hidden />
      {[running > 0 ? `${running} running` : null, done > 0 ? `${done} done` : null].filter(Boolean).join(' · ')}
      <span className="status-label"> · {tools} {tools === 1 ? 'tool' : 'tools'}</span>
    </>
  )
  return (
    <Popover label={label} title="Sub-agents in the latest turn (stop one from its panel or the Sub-agents tab)" className={`status-item status-button subagent-chip${running > 0 ? ' running' : ''}`}>
      {(close) => (
        <div className="subagent-list" role="list" aria-label="Sub-agents">
          {list.map(({ toolCall, subagent }) => (
            <div key={toolCall.id} className="subagent-list-row" role="listitem">
              <button
                className="subagent-list-open"
                onClick={() => {
                  actions?.open(toolCall.id)
                  close()
                }}
                title="Show what it did"
              >
                <StateIcon s={subagent} />
                <span className="subagent-title">{toolCall.title}</span>
                <span className="subagent-stats">{stats(subagent, now)}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </Popover>
  )
}
