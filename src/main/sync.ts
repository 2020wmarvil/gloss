// Shared sessions (SPEC → Shared sessions): the agent's session/load replay is the
// source of truth for a session's log. This reads a replay and matches it against
// the cached log, so entries Gloss already has keep their ids, threads and fields.
import { fileURLToPath } from 'node:url'
import type * as acp from '@agentclientprotocol/sdk'
import type { Attachment, Message, Plan, PlanEntry, Thread, ToolCall } from '../shared/types'
import { MAIN_TAG, threadTag, threadToMainTag } from '../shared/wire'
import { isRangeNote } from '../shared/review'

/** One entry of the agent's history, as its replay tells it. */
export type ReplayEntry =
  | { type: 'user'; acpMessageId?: string; wire: string; attachments: Attachment[] }
  | { type: 'agent'; acpMessageId?: string; text: string }
  | { type: 'tool'; toolCall: Pick<ToolCall, 'id' | 'title' | 'status' | 'kind' | 'content'> }
  | { type: 'plan'; entries: PlanEntry[] }

/** One entry of the cached log. */
export type CachedEntry =
  | { type: 'message'; message: Message }
  | { type: 'toolCall'; toolCall: ToolCall }
  | { type: 'plan'; plan: Plan }

export type SyncItem = { cached: CachedEntry; replay?: ReplayEntry } | { cached?: undefined; replay: ReplayEntry }

/** The updates of the conversation itself, which a replay is made of. */
export function isLogUpdate(u: acp.SessionUpdate): boolean {
  return (
    u.sessionUpdate === 'user_message_chunk' ||
    u.sessionUpdate === 'agent_message_chunk' ||
    u.sessionUpdate === 'tool_call' ||
    u.sessionUpdate === 'tool_call_update' ||
    u.sessionUpdate === 'plan'
  )
}

// How the Claude adapter replays an embedded text file: a link chunk, then a context chunk.
const FILE_LINK = /^\[@([^\]]*)\]\(([^)\s]+)\)$/
const FILE_CONTEXT = /^\n<context ref="([^"]*)">\n([\s\S]*)\n<\/context>$/

/**
 * User messages Claude Code writes itself: the summary that starts the history
 * after a compaction, and the marker of a cancelled turn. Not shown.
 */
function isSynthetic(wire: string): boolean {
  const text = wire.trim()
  return (
    text.startsWith('This session is being continued from a previous conversation') ||
    /^\[Request interrupted by user[^\]]*\]$/.test(text)
  )
}

/**
 * Groups a replay into entries, as a live turn would record them: messages split
 * by `messageId` and at tool calls and plans, one plan per user message.
 */
export function parseReplay(updates: acp.SessionUpdate[]): ReplayEntry[] {
  const out: ReplayEntry[] = []
  type User = Extract<ReplayEntry, { type: 'user' }>
  type Agent = Extract<ReplayEntry, { type: 'agent' }>
  type Tool = Extract<ReplayEntry, { type: 'tool' }>
  type PlanItem = Extract<ReplayEntry, { type: 'plan' }>
  let user: User | undefined
  let agent: Agent | undefined
  let plan: PlanItem | undefined
  /** A tool call or a plan since the last text: the next text starts a new message. */
  let afterBreak = false
  /** A file link waiting for its context chunk. */
  let link: { text: string; name: string; uri: string } | undefined
  const tools = new Map<string, Tool>()

  const flushLink = (): void => {
    if (user && link) user.wire += link.text
    link = undefined
  }

  for (const u of updates) {
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        const id = u.messageId ?? undefined
        const different = id !== undefined && user?.acpMessageId !== undefined && user.acpMessageId !== id
        if (!user || agent || afterBreak || different) {
          flushLink()
          user = { type: 'user', ...(id !== undefined ? { acpMessageId: id } : {}), wire: '', attachments: [] }
          out.push(user)
          agent = undefined
          plan = undefined
          afterBreak = false
        }
        if (u.content.type === 'text') {
          const text = u.content.text
          const isLink = FILE_LINK.exec(text)
          if (isLink) {
            flushLink()
            link = { text, name: isLink[1], uri: isLink[2] }
            break
          }
          const context = FILE_CONTEXT.exec(text)
          if (context && link && context[1] === link.uri) {
            user.attachments.push(fileAttachment(link.name, link.uri, context[2]))
            link = undefined
            break
          }
          flushLink()
          user.wire += text
        } else if (u.content.type === 'image' && u.content.data) {
          flushLink()
          user.attachments.push({ kind: 'image', name: 'image', mimeType: u.content.mimeType, data: u.content.data })
        }
        break
      }
      case 'agent_message_chunk': {
        if (u.content.type !== 'text') break
        flushLink()
        const id = u.messageId ?? undefined
        const different = id !== undefined && agent?.acpMessageId !== undefined && agent.acpMessageId !== id
        if (!agent || afterBreak || different) {
          agent = { type: 'agent', ...(id !== undefined ? { acpMessageId: id } : {}), text: '' }
          out.push(agent)
          user = undefined
          afterBreak = false
        }
        agent.text += u.content.text
        break
      }
      case 'tool_call':
      case 'tool_call_update': {
        flushLink()
        let tool = tools.get(u.toolCallId)
        if (!tool) {
          tool = { type: 'tool', toolCall: { id: u.toolCallId, title: 'Tool call', status: 'pending' } }
          tools.set(u.toolCallId, tool)
          out.push(tool)
          afterBreak = true
        }
        const t = tool.toolCall
        if (u.title != null) t.title = u.title
        if (u.status != null) t.status = u.status
        if (u.kind != null) t.kind = u.kind
        if (u.content != null) t.content = u.content
        break
      }
      case 'plan': {
        flushLink()
        const entries = u.entries.map(
          (e): PlanEntry => ({ content: e.content, status: e.status, ...(e.priority ? { priority: e.priority } : {}) })
        )
        if (plan) plan.entries = entries
        else if (entries.length > 0) {
          plan = { type: 'plan', entries }
          out.push(plan)
          afterBreak = true
        }
        break
      }
    }
  }
  flushLink()
  return out.filter((e) => e.type !== 'user' || ((e.wire.trim() !== '' || e.attachments.length > 0) && !isSynthetic(e.wire)))
}

function fileAttachment(name: string, uri: string, text: string): Attachment {
  let path: string | undefined
  try {
    // Gloss sends `file:///<name>` for a file without a path.
    const p = fileURLToPath(uri)
    if (uri !== `file:///${encodeURIComponent(name)}`) path = p
  } catch {
    // Not a file URL.
  }
  return { kind: 'file', name, ...(path ? { path } : {}), text }
}

/** What identifies an entry in both logs; plans have no identity of their own. */
function key(e: ReplayEntry | CachedEntry): string | null {
  switch (e.type) {
    case 'user':
      return `u\0${e.wire}`
    case 'agent':
      return e.acpMessageId !== undefined ? `a\0${e.acpMessageId}` : `t\0${e.text}`
    case 'tool':
      return `c\0${e.toolCall.id}`
    case 'toolCall':
      return `c\0${e.toolCall.id}`
    case 'message': {
      const m = e.message
      if (m.role === 'user') return `u\0${m.wireText ?? m.text}`
      return m.acpMessageId !== undefined ? `a\0${m.acpMessageId}` : `t\0${m.text}`
    }
    case 'plan':
      return null
  }
}

/** Keys made unique by counting repeats ("ok" twice: "ok#0", "ok#1"). */
function uniqueKeys(entries: (ReplayEntry | CachedEntry)[]): (string | null)[] {
  const seen = new Map<string, number>()
  return entries.map((e) => {
    const k = key(e)
    if (k === null) return null
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return `${k}\0${n}`
  })
}

/**
 * Matches the replay against the cached log, in order. Returns the new log and
 * the cached entries the agent's session no longer has.
 *
 * - A matched entry keeps its cached row.
 * - Cached entries before the first match are kept: the replay can start partway
 *   (after a compaction, it starts at the summary).
 * - Other unmatched cached entries are removed, except plans: a replay only
 *   reports plans again for turns the cache doesn't have.
 */
export function matchReplay(cached: CachedEntry[], replay: ReplayEntry[]): { log: SyncItem[]; removed: CachedEntry[] } {
  const cachedKeys = uniqueKeys(cached)
  const at = new Map<string, number>()
  cachedKeys.forEach((k, i) => {
    if (k !== null) at.set(k, i)
  })
  const replayKeys = uniqueKeys(replay)

  const log: SyncItem[] = []
  const removed: CachedEntry[] = []
  /** New entries before the first match; they go after the cached entries the replay doesn't cover. */
  const lead: SyncItem[] = []
  let next = 0
  let matched = false
  /** The latest user message is new, so the plans after it are too. */
  let newTurn = false

  replay.forEach((r, ri) => {
    const k = replayKeys[ri]
    const i = k === null ? undefined : at.get(k)
    if (r.type === 'plan') {
      if (newTurn) (matched ? log : lead).push({ replay: r })
      return
    }
    if (i === undefined || i < next) {
      ;(matched ? log : lead).push({ replay: r })
      if (r.type === 'user') newTurn = true
      return
    }
    for (let j = next; j < i; j++) {
      const c = cached[j]
      if (!matched || c.type === 'plan') log.push({ cached: c })
      else removed.push(c)
    }
    if (!matched) log.push(...lead.splice(0))
    log.push({ cached: cached[i], replay: r })
    next = i + 1
    matched = true
    if (r.type === 'user') newTurn = false
  })

  if (!matched) return { log: [...cached.map((c) => ({ cached: c })), ...lead], removed }
  for (let j = next; j < cached.length; j++) {
    const c = cached[j]
    if (c.type === 'plan') log.push({ cached: c })
    else removed.push(c)
  }
  return { log, removed }
}

/**
 * Where a user message from elsewhere goes (SPEC → Shared sessions): to the thread
 * its tag names, else to the main thread. Returns its thread and display text.
 * `active` ranks threads by how recently they were used.
 */
export function placeUserMessage(
  wire: string,
  threads: Thread[],
  active: Map<string, number>
): { threadId: string | null; text: string } {
  // A review's range note is for the agent only.
  const noteEnd = wire.indexOf('\n')
  if (noteEnd >= 0 && isRangeNote(wire.slice(0, noteEnd))) return placeUserMessage(wire.slice(noteEnd + 1), threads, active)
  const nl = wire.indexOf('\n')
  const first = nl < 0 ? wire : wire.slice(0, nl)
  const rest = nl < 0 ? '' : wire.slice(nl + 1)
  if (first === MAIN_TAG) return { threadId: null, text: rest }
  // Sent to the main conversation from a thread ("Send to main").
  if (threads.some((t) => threadToMainTag(t.anchor) === first)) return { threadId: null, text: rest }
  if (first.startsWith('[re: ')) {
    const named = threads.filter((t) => threadTag(t.anchor) === first)
    const rank = (t: Thread): number => active.get(t.id) ?? -1
    const thread = named.sort((a, b) => rank(b) - rank(a) || b.createdAt - a.createdAt)[0]
    if (thread) return { threadId: thread.id, text: rest }
  }
  return { threadId: null, text: wire }
}
