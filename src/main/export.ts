// A session or one thread as markdown, for pasting into a PR description, chat or a doc.
import type { Message, Session, Thread, ToolCall } from '../shared/types'
import type { Anchor } from '../shared/types'
import { lineLabel } from '../shared/review'
import { pinList, truncate } from '../shared/wire'

type Log = { session: Session; messages: Message[]; toolCalls: ToolCall[]; threads: Thread[] }

/** The log of one thread (null = main) as markdown blocks. */
function blocks(log: Log, threadId: string | null): string[] {
  const items = [
    ...log.messages.filter((m) => m.threadId === threadId).map((m) => ({ seq: m.seq, message: m })),
    ...log.toolCalls.filter((t) => t.threadId === threadId).map((t) => ({ seq: t.messageSeq, toolCall: t }))
  ].sort((a, b) => a.seq - b.seq)
  const out: string[] = []
  for (const item of items) {
    if ('toolCall' in item) {
      out.push(`_Tool: ${item.toolCall.title} (${item.toolCall.status.replace('_', ' ')})_`)
      continue
    }
    const m = item.message
    const attached = m.attachments?.length ? `\n\n_Attached: ${m.attachments.map((a) => a.name).join(', ')}_` : ''
    // An annotated screenshot's pins, as the agent got them.
    const pins = m.attachments ? pinList(m.attachments) : ''
    out.push(`**${m.role === 'user' ? 'You' : 'Agent'}**\n\n${m.text.trim()}${attached}${pins ? `\n\n${pins}` : ''}`)
  }
  return out
}

/** What a thread's heading names: its text, after the file and lines for diff lines. */
function heading(anchor: Anchor): string {
  const text = `“${truncate(anchor.text, 60)}”`
  return anchor.kind === 'line' ? `${lineLabel(anchor)} ${text}` : text
}

/** The agent's finding that opened a review thread, as its first block. */
function finding(thread: Thread): string[] {
  const f = thread.finding
  return f ? [`**Agent** (${f.severity})\n\n**${f.title}**${f.body ? `\n\n${f.body}` : ''}`] : []
}

function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

/** The whole session: the main thread, then each thread under a heading. Or just one thread. */
export function toMarkdown(log: Log, threadId: string | null): string {
  if (threadId !== null) {
    const thread = log.threads.find((t) => t.id === threadId)
    if (!thread) throw new Error(`Unknown thread ${threadId}`)
    return [`# Thread: ${heading(thread.anchor)}`, `From ${log.session.title}`, quote(thread.anchor.text), ...finding(thread), ...blocks(log, threadId)].join('\n\n') + '\n'
  }
  const parts = [`# ${log.session.title}`, ...blocks(log, null)]
  for (const thread of log.threads) {
    const replies = [...finding(thread), ...blocks(log, thread.id)]
    if (replies.length === 0) continue
    parts.push(`## Thread: ${heading(thread.anchor)}`, quote(thread.anchor.text), ...replies)
  }
  return parts.join('\n\n') + '\n'
}
