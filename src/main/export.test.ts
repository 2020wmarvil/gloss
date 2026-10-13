import { describe, expect, it } from 'vitest'
import type { Message, Session, Thread, ToolCall } from '../shared/types'
import { toMarkdown } from './export'
import { parseGitStatus } from './git'

const session: Session = { id: 's', agentId: 'a', acpSessionId: 'x', cwd: '/w', title: 'Order review', createdAt: 0 }
const msg = (seq: number, role: Message['role'], text: string, threadId: string | null = null): Message => ({
  id: `m${seq}`,
  sessionId: 's',
  seq,
  role,
  text,
  threadId
})
const messages: Message[] = [
  { ...msg(0, 'user', 'Review it'), attachments: [{ kind: 'file', name: 'notes.md', text: 'x' }] },
  msg(2, 'agent', '1. Cache race\n2. N+1 query'),
  msg(3, 'user', 'Show the interleaving', 't1'),
  msg(4, 'agent', 'Writer invalidates, then...', 't1')
]
const toolCalls: ToolCall[] = [
  { id: 'tc', sessionId: 's', messageSeq: 1, threadId: null, title: 'Read orders.ts', status: 'completed' }
]
const threads: Thread[] = [
  { id: 't1', sessionId: 's', anchorMessageId: 'm2', anchor: { kind: 'listItem', path: [0], text: 'Cache race' }, createdAt: 0 },
  { id: 't2', sessionId: 's', anchorMessageId: 'm2', anchor: { kind: 'listItem', path: [1], text: 'N+1 query' }, createdAt: 0 }
]
const log = { session, messages, toolCalls, threads }

describe('toMarkdown', () => {
  it('exports the main thread, then each thread with replies', () => {
    expect(toMarkdown(log, null)).toBe(
      [
        '# Order review',
        '**You**\n\nReview it\n\n_Attached: notes.md_',
        '_Tool: Read orders.ts (completed)_',
        '**Agent**\n\n1. Cache race\n2. N+1 query',
        '## Thread: “Cache race”',
        '> Cache race',
        '**You**\n\nShow the interleaving',
        '**Agent**\n\nWriter invalidates, then...'
      ].join('\n\n') + '\n'
    )
  })

  it('exports one thread', () => {
    expect(toMarkdown(log, 't1')).toBe(
      [
        '# Thread: “Cache race”',
        'From Order review',
        '> Cache race',
        '**You**\n\nShow the interleaving',
        '**Agent**\n\nWriter invalidates, then...'
      ].join('\n\n') + '\n'
    )
  })
})

describe('parseGitStatus', () => {
  it('reads the branch and whether the tree is dirty', () => {
    expect(parseGitStatus('## main...origin/main [ahead 1]\n')).toEqual({ branch: 'main', dirty: false })
    expect(parseGitStatus('## dev\n M src/a.ts\n?? b.ts\n')).toEqual({ branch: 'dev', dirty: true })
    expect(parseGitStatus('## No commits yet on main\n')).toEqual({ branch: 'main', dirty: false })
    expect(parseGitStatus('## HEAD (no branch)\n')).toEqual({ branch: 'detached HEAD', dirty: false })
    expect(parseGitStatus('')).toBeNull()
  })
})
