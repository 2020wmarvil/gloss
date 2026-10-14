import { expect, it } from 'vitest'
import { handoffTranscript } from './handoff-transcript'
import type { Message, Session, Thread, ToolCall } from '../shared/types'

const session: Session = { id: 's', agentId: 'claude', acpSessionId: 'a', title: 'Cache work', cwd: '/project', createdAt: 0 }
const thread: Thread = { id: 't', sessionId: 's', anchorMessageId: 'anchor', anchor: { kind: 'selection', start: 0, end: 5, text: 'Cache invalidation' }, createdAt: 1 }
const messages: Message[] = [
  { id: 'm1', sessionId: 's', seq: 0, role: 'user', threadId: null, text: 'Main request', attachments: [{ kind: 'file', name: 'notes.md', text: 'Full text attachment' }, { kind: 'image', name: 'capture.png', mimeType: 'image/png', data: 'binary-must-not-transfer' }] },
  { id: 'm2', sessionId: 's', seq: 2, role: 'agent', threadId: null, text: 'Main reply' },
  { id: 'm3', sessionId: 's', seq: 3, role: 'user', threadId: 't', text: 'Thread request' }
]
const tools: ToolCall[] = [
  { id: 'tool', sessionId: 's', messageSeq: 1, threadId: null, title: 'Run tests', status: 'completed', content: [{ type: 'text', text: 'tests passed ```' }] },
  { id: 'thread-tool', sessionId: 's', messageSeq: 4, threadId: 't', title: 'Read cache.ts', status: 'completed', content: [{ type: 'diff', path: 'cache.ts', oldText: 'before', newText: 'after' }] }
]

it('keeps chronological messages, complete tool output and text attachments', () => {
  const transcript = handoffTranscript(session, undefined, messages, tools, [thread])
  expect(transcript.indexOf('Main request')).toBeLessThan(transcript.indexOf('Run tests'))
  expect(transcript.indexOf('Run tests')).toBeLessThan(transcript.indexOf('Main reply'))
  expect(transcript).toContain('Full text attachment')
  expect(transcript).toContain('tests passed ```')
  expect(transcript).toContain('````json')
  expect(transcript).toContain('capture.png (image data is not included)')
  expect(transcript).not.toContain('binary-must-not-transfer')
  expect(transcript).toContain('"oldText": "before"')
})

it('restricts thread snapshots to the anchor and that thread', () => {
  const transcript = handoffTranscript(session, thread, messages, tools, [thread])
  expect(transcript).toContain('Cache invalidation')
  expect(transcript).toContain('Thread request')
  expect(transcript).toContain('Read cache.ts')
  expect(transcript).not.toContain('Main request')
  expect(transcript).not.toContain('tests passed')
  expect(transcript).not.toContain('Full text attachment')
})
