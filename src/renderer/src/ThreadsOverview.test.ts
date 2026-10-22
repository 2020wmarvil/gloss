import { describe, expect, it } from 'vitest'
import type { Message, Thread } from '@shared/types'
import type { OpenSession } from './App'
import { messageStart, threadSummaries } from './ThreadsOverview'

const thread = (id: string, createdAt: number): Thread => ({
  id,
  sessionId: 's',
  anchorMessageId: 'a',
  anchor: { kind: 'listItem', path: [0], text: id },
  createdAt
})

const message = (seq: number, threadId: string | null, createdAt?: number): Message => ({
  id: `m${seq}`,
  sessionId: 's',
  seq,
  role: 'user',
  text: '',
  threadId,
  ...(createdAt !== undefined ? { createdAt } : {})
})

describe('threadSummaries', () => {
  it('counts replies and lists the oldest thread first', () => {
    const open: OpenSession = {
      session: {
        id: 's',
        agentId: 'x',
        acpSessionId: 'x',
        cwd: '/w',
        title: 't',
        createdAt: 0
      },
      messages: [
        message(0, null, 50),
        message(1, 'old', 10),
        message(2, 'old', 30),
        message(3, 'legacy'),
        message(4, 'new', 20)
      ],
      toolCalls: [],
      plans: [],
      threads: [thread('old', 5), thread('legacy', 25), thread('new', 15)]
    }
    expect(threadSummaries(open).map((s) => [s.thread.id, s.replies, s.lastActivity])).toEqual([
      ['old', 2, 30],
      ['new', 1, 20],
      ['legacy', 1, 25]
    ])
  })
})

describe('messageStart', () => {
  it('is the first line as plain text, with … when there is more', () => {
    expect(messageStart('All 14 tests pass.')).toBe('All 14 tests pass.')
    expect(messageStart('All 14 tests pass. Four changes worth making:\n\n1. **Sweep**')).toBe('All 14 tests pass. Four changes worth making…')
    expect(messageStart('## **Test results:** `npm test` fails')).toBe('Test results: npm test fails')
    expect(messageStart('one two three four', 10)).toBe('one two…')
  })
})
