import type { Message, Session, Thread } from './types'

export type HandoffRequest = {
  sessionId: string
  threadId: string | null
  agentId: string
  summary: string
  messageIds: string[]
}

export type HandoffSource = {
  sessionId: string
  threadId: string | null
  title: string
  agentId: string
  quote?: string
}

export const MAX_HANDOFF_CHARS = 200_000

/** Exact prompt shared by the preview and main process. No tools or binary attachments. */
export function handoffText(session: Session, thread: Thread | undefined, summary: string, messages: Message[], threads: Thread[]): string {
  const context = messages.map((m) => {
    const quote = threads.find((t) => t.id === m.threadId)?.anchor.text
    const location = m.threadId ? `Thread: ${quote ?? 'unavailable anchor'}` : 'Main conversation'
    return `${m.role === 'user' ? 'You' : 'Agent'} / ${location}:\n${m.text}`
  }).join('\n\n')
  return [
    'You are continuing work handed off from another agent in Gloss.',
    `Source: ${session.title} / ${session.agentId} / ${thread ? `Thread: ${thread.anchor.text}` : 'Conversation'}`,
    `Project: ${session.cwd}`,
    '', 'Summary:', summary.trim(),
    ...(context ? ['', 'Selected conversation context (past messages, for reference):', context] : []),
    '', 'Use this context to continue the work. Ask if the next step is unclear.'
  ].join('\n')
}

export function handoffSummary(session: Session, thread: Thread | undefined, messages: Message[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'agent' && (!thread || m.threadId === thread.id))
  return `Continue ${thread ? `the discussion about "${thread.anchor.text.slice(0, 500)}"` : `work on "${session.title.slice(0, 500)}"`}.` +
    (last ? `\n\nLatest response from the source agent:\n${last.text.slice(0, 4000)}${last.text.length > 4000 ? '\n[Excerpt ends here.]' : ''}` : '')
}
