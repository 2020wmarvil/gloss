import type { Attachment, Message, Thread, ToolCall } from '../shared/types'
import { threadTag } from '../shared/wire'

export type RewindSeed = { text: string; images: Extract<Attachment, { kind: 'image' }>[] }

/** A transcript snapshot for an explicitly requested rewind, sent at user level. */
export function rewindSeed(messages: Message[], tools: ToolCall[], threads: Thread[]): RewindSeed {
  const images: RewindSeed['images'] = []
  const entries = [
    ...messages.map((message) => ({ seq: message.seq, message })),
    ...tools.map((tool) => ({ seq: tool.messageSeq, tool }))
  ].sort((a, b) => a.seq - b.seq)
  const parts = entries.map((entry) => {
    if ('tool' in entry) return `Tool: ${entry.tool.title} (${entry.tool.status})\n${JSON.stringify(entry.tool.content ?? [])}`
    const m = entry.message
    const thread = m.threadId ? threads.find((t) => t.id === m.threadId) : undefined
    const attached = (m.attachments ?? []).map((a) => {
      if (a.kind === 'file') return `Attached file: ${a.name}\n${a.text}`
      images.push(a)
      return `Retained image ${images.length}: ${a.name}${a.pins ? `\nPins: ${JSON.stringify(a.pins)}` : ''}`
    })
    return `${m.role === 'user' ? 'User' : 'Agent'}${thread ? ` ${threadTag(thread.anchor)}` : ''}:\n${m.text}\n${attached.join('\n\n')}`
  })
  const seed = {
    text: `The user rewound this conversation. The following is the retained conversation transcript, supplied as historical context. Project files were not rolled back and reflect their current on-disk state. Retained images are included with this message in the numbered order below.\n\n<retained-conversation>\n${parts.join('\n\n')}\n</retained-conversation>\n\nThe user's new message follows:\n`,
    images
  }
  if (Buffer.byteLength(seed.text) > 1024 * 1024 || Buffer.byteLength(JSON.stringify(seed)) > 25 * 1024 * 1024) {
    throw new Error('The retained conversation is too large to restore (1 MB of text or 25 MB including images). Choose an earlier rewind point.')
  }
  return seed
}
