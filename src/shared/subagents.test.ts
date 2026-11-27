import { describe, expect, it } from 'vitest'
import type { Subagent } from './types'
import { applyFeedUpdate, applyState, cleanReply, formatDuration, MAX_FEED_CONTENT, subagentDuration, subagentStatus } from './subagents'

const fresh = (): Subagent => ({ acpSessionId: 'c', state: 'running', startedAt: 0, feed: [] })

describe('sub-agent feeds', () => {
  it('joins a message streamed in chunks and updates a tool call in place', () => {
    const s = fresh()
    applyFeedUpdate(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Look' }, messageId: 'm1' } as never)
    applyFeedUpdate(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ing' }, messageId: 'm1' } as never)
    applyFeedUpdate(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending' } as never)
    applyFeedUpdate(s, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } as never)
    applyFeedUpdate(s, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' }, messageId: 'm2' } as never)
    expect(s.feed).toEqual([
      { type: 'text', id: 'm1', text: 'Looking' },
      { type: 'tool', id: 't1', title: 'Read', status: 'completed' },
      { type: 'text', id: 'm2', text: 'Done' }
    ])
  })

  it('leaves out output too large to keep', () => {
    const s = fresh()
    const big = [{ type: 'content', content: { type: 'text', text: 'x'.repeat(MAX_FEED_CONTENT) } }]
    applyFeedUpdate(s, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', status: 'completed', content: big } as never)
    expect(s.feed[0]).not.toHaveProperty('content')
  })

  it('times a run from its state and names how it ended', () => {
    const s = fresh()
    applyState(s, { state: 'idle', stopReason: 'cancelled' }, 65_000)
    expect(s).toMatchObject({ state: 'idle', stopReason: 'cancelled', endedAt: 65_000 })
    expect(subagentStatus(s)).toBe('cancelled')
    expect(formatDuration(subagentDuration(s, 99_999)!)).toBe('1m 05s')
    applyState(s, { state: 'running' }, 70_000)
    expect(s.endedAt).toBeUndefined()
    expect(subagentStatus(s)).toBe('in_progress')
  })

  it("drops the adapter's note of the tools used from an answer", () => {
    expect(cleanReply('<tools-used-before-summary>Read</tools-used-before-summary>\nalpha')).toBe('alpha')
    expect(cleanReply('Async agent launched successfully. (This tool result is internal metadata)')).toBe('')
  })
})
