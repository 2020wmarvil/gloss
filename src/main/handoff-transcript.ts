import type { Message, Session, Thread, ToolCall } from '../shared/types'

/** A stable, chronological snapshot. A thread includes its anchor but no other threads. */
export function handoffTranscript(session: Session, thread: Thread | undefined, messages: Message[], tools: ToolCall[], threads: Thread[]): string {
  const entries = [
    ...messages.filter((m) => !thread || m.threadId === thread.id).map((message) => ({ seq: message.seq, message })),
    ...tools.filter((t) => !thread || t.threadId === thread.id).map((tool) => ({ seq: tool.messageSeq, tool }))
  ].sort((a, b) => a.seq - b.seq)
  const location = (id: string | null): string => id === null ? 'Main conversation' : `Thread: ${threads.find((t) => t.id === id)?.anchor.text ?? 'unavailable anchor'}`
  const out = [`# ${session.title}`, `Source agent: ${session.agentId}\nProject: ${session.cwd}`]
  if (thread) out.push(`## Thread anchor\n\n${thread.anchor.text}`)
  for (const entry of entries) {
    if ('message' in entry) {
      const m = entry.message
      out.push(`## ${m.role === 'user' ? 'You' : 'Agent'} / ${location(m.threadId)}\n\n${m.text}`)
      for (const a of m.attachments ?? []) out.push(a.kind === 'file'
        ? `### Attachment: ${a.name}\n\n${a.text}` : `_Image attachment: ${a.name} (image data is not included)_`)
    } else {
      const t = entry.tool
      out.push(`## Tool / ${location(t.threadId)}\n\n${t.title} (${t.status})`)
      if (t.content !== undefined) {
        const text = JSON.stringify(t.content, null, 2)
        const longest = (text.match(/`+/g) ?? []).reduce((length, s) => Math.max(length, s.length), 2)
        const fence = '`'.repeat(longest + 1)
        out.push(`${fence}json\n${text}\n${fence}`)
      }
    }
  }
  return out.join('\n\n') + '\n'
}
