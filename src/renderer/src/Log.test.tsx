// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Message, Thread } from '@shared/types'
import { threadToMainTag } from '@shared/wire'
import type { OpenSession } from './App'
import { Log, logItems } from './Log'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const thread: Thread = { id: 't', sessionId: 's', anchorMessageId: 'anchor', anchor: { kind: 'selection', start: 0, end: 5, text: 'point' }, createdAt: 1 }
const reply: Message = { id: 'reply', sessionId: 's', seq: 1, role: 'user', text: 'Discuss here', threadId: 't' }
const continuation: Message = { id: 'main-message', sessionId: 's', seq: 2, role: 'user', text: 'Continue with this change', threadId: null, wireText: `${threadToMainTag(thread.anchor)}\nContinue with this change` }
const open: OpenSession = {
  session: { id: 's', agentId: 'codex', acpSessionId: 'native', cwd: '/w', title: 'Test', createdAt: 0 },
  messages: [reply, continuation], toolCalls: [], plans: [], threads: [thread]
}

describe('Send to main traces', () => {
  it('leaves an ordered reference in the source thread and keeps one actual message in main', () => {
    const restored = JSON.parse(JSON.stringify(open)) as OpenSession
    expect(logItems(restored, [], 't').map((i) => [i.kind, i.seq])).toEqual([['message', 1], ['sentToMain', 2]])
    expect(logItems(restored, [], null).map((i) => i.kind)).toEqual(['message'])
    expect(logItems(restored, [], 'another-thread')).toEqual([])
    expect(restored.messages).toHaveLength(2)
    expect(logItems({ ...restored, messages: [reply] }, [], 't').map((i) => i.kind)).toEqual(['message'])
  })

  it('uses the most recently active source when two anchors have the same tag', () => {
    const same: Thread = { ...thread, id: 'other', createdAt: 2 }
    const history = { ...open, threads: [thread, same] }
    expect(logItems(history, [], 't').at(-1)?.kind).toBe('sentToMain')
    expect(logItems(history, [], 'other')).toEqual([])
  })

  it('shows a preview and navigates to the actual main message on click', () => {
    const el = document.createElement('div')
    document.body.replaceChildren(el)
    const root = createRoot(el)
    const reveal = vi.fn()
    try {
      act(() => root.render(<Log items={logItems(open, [], 't')} className="thread-log" empty={null} renderAgent={() => null} onRevealMain={reveal} />))
      const trace = el.querySelector('.sent-to-main-trace')!
      expect(trace.textContent).toContain('Continue with this change')
      act(() => trace.querySelector<HTMLButtonElement>('button')!.click())
      expect(reveal).toHaveBeenCalledExactlyOnceWith(continuation)
      expect(el.querySelectorAll('.sent-message')).toHaveLength(1)
    } finally { act(() => root.unmount()) }
  })
})
