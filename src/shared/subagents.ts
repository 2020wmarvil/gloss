// Sub-agents (SPEC → Sub-agents): the agent's child sessions, shown as one card each in the
// log. The card is a tool call of kind `subagent` whose content holds the sub-agent.
import type { Subagent, SubagentFeedItem, ToolCall } from './types'

export const SUBAGENT_KIND = 'subagent'

/** The largest tool call content (as JSON) a sub-agent's feed keeps. */
export const MAX_FEED_CONTENT = 16_000

/** The sub-agent a tool call stands for, or null for any other tool call. */
export function subagentOf(t: Pick<ToolCall, 'kind' | 'content'>): Subagent | null {
  if (t.kind !== SUBAGENT_KIND) return null
  const s = (t.content as { subagent?: Subagent } | null | undefined)?.subagent
  return s && typeof s === 'object' && Array.isArray(s.feed) ? s : null
}

/** The tool call status that stands for the sub-agent's state. */
export function subagentStatus(s: Pick<Subagent, 'state' | 'stopReason'>): string {
  if (s.state === 'running' || s.state === 'requires_action') return 'in_progress'
  if (s.state === 'unknown') return 'completed'
  if (s.stopReason === 'cancelled') return 'cancelled'
  if (s.stopReason === 'error' || s.stopReason === 'refusal') return 'failed'
  return 'completed'
}

export function isSubagentRunning(s: Pick<Subagent, 'state'>): boolean {
  return s.state === 'running' || s.state === 'requires_action'
}

/** How many tool calls the sub-agent made. */
export function subagentToolCount(s: Pick<Subagent, 'feed'>): number {
  let n = 0
  for (const item of s.feed) if (item.type === 'tool') n++
  return n
}

/** How long it ran, in ms, or null when Gloss didn't see it start. */
export function subagentDuration(s: Pick<Subagent, 'startedAt' | 'endedAt' | 'state'>, now: number): number | null {
  if (s.startedAt === undefined) return null
  const end = s.endedAt ?? (isSubagentRunning(s) ? now : undefined)
  return end === undefined ? null : Math.max(0, end - s.startedAt)
}

/** "4s", "2m 05s", "1h 03m". */
export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  if (total < 60) return `${total}s`
  const m = Math.floor(total / 60)
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** The text of a session message's content blocks. */
export function messageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
    .join('')
}

/**
 * A sub-agent's reply without the adapter's note of the tools it used. Empty for the result
 * of a launch in the background, which is Claude Code's note to the model, not an answer.
 */
export function cleanReply(text: string): string {
  const reply = text.replace(/<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>\s*/g, '').trim()
  return /^Async agent launched successfully/.test(reply) ? '' : reply
}

/** The ACP updates a sub-agent's own session reports that its feed shows. */
type FeedUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content: { type: string; text?: string }; messageId?: string | null }
  | {
      sessionUpdate: 'tool_call' | 'tool_call_update'
      toolCallId: string
      title?: string | null
      status?: string | null
      kind?: string | null
      content?: unknown
    }

/**
 * Adds an update of the sub-agent's own session to its feed, in place. Returns whether
 * the feed changed.
 */
export function applyFeedUpdate(s: Subagent, u: { sessionUpdate: string }): boolean {
  const update = u as FeedUpdate
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type !== 'text' || !update.content.text) return false
      const id = update.messageId ?? ''
      const last = s.feed[s.feed.length - 1]
      if (last?.type === 'text' && (last.id === id || !id || !last.id)) last.text += update.content.text
      else s.feed.push({ type: 'text', id, text: update.content.text })
      return true
    }
    case 'tool_call':
    case 'tool_call_update': {
      let tool = s.feed.find((i): i is Extract<SubagentFeedItem, { type: 'tool' }> => i.type === 'tool' && i.id === update.toolCallId)
      if (!tool) {
        tool = { type: 'tool', id: update.toolCallId, title: 'Tool call', status: 'pending' }
        s.feed.push(tool)
      }
      if (update.title != null) tool.title = update.title
      if (update.status != null) tool.status = update.status
      if (update.kind != null) tool.kind = update.kind
      // A card holds its whole feed: a large output (a long file read) is left out of it.
      if (update.content != null) {
        if (JSON.stringify(update.content).length <= MAX_FEED_CONTENT) tool.content = update.content
        else delete tool.content
      }
      return true
    }
    default:
      return false
  }
}

/** The state a `subagent_update`'s state snapshot gives, stamped with the time it changed. */
export function applyState(
  s: Subagent,
  state: { state: string; stopReason?: string | null; error?: { message?: string } | null },
  now: number | undefined
): void {
  const next = (['running', 'idle', 'requires_action', 'unknown'] as const).find((x) => x === state.state) ?? 'unknown'
  const wasRunning = isSubagentRunning(s)
  s.state = next
  if (isSubagentRunning(s)) {
    delete s.stopReason
    delete s.error
    if (!wasRunning) delete s.endedAt
    if (now !== undefined && s.startedAt === undefined) s.startedAt = now
  } else {
    if (state.stopReason) s.stopReason = state.stopReason
    if (state.error?.message) s.error = state.error.message
    if (now !== undefined && wasRunning && s.startedAt !== undefined) s.endedAt = now
  }
}
