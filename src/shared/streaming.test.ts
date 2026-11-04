import { expect, it } from 'vitest'
import { appendText } from './streaming'
import type { Message } from './types'

it('ignores an addition that does not continue the message where it ends', () => {
  const messages: Message[] = [{ id: 'm', sessionId: 's', seq: 0, role: 'agent', text: 'abc', threadId: null }]
  expect(appendText(messages, 'm', 3, 'def')[0].text).toBe('abcdef')
  expect(appendText(messages, 'm', 1, 'xyz')).toBe(messages)
  expect(appendText(messages, 'other', 0, 'xyz')).toBe(messages)
})
