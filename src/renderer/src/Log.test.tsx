// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { Message, Thread } from '@shared/types'
import { threadToMainTag, withForkSummary } from '@shared/wire'
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

describe('Fork threads', () => {
  const fork: Thread = { ...thread, fork: { sessionId: 'fork-session' } }
  // The fork's messages are numbered in its own session, after what it inherited.
  const forkReply: Message = { ...reply, seq: 40, createdAt: 10 }
  const later: Message = { ...reply, id: 'later', seq: 42, text: 'More here', createdAt: 30 }
  const sent: Message = {
    ...continuation, seq: 3, createdAt: 20,
    wireText: withForkSummary(`${threadToMainTag(thread.anchor)}\nContinue with this change`, '- Renamed `a`.')
  }
  const forked: OpenSession = { ...open, messages: [forkReply, sent, later], threads: [fork] }

  it('places Send to main among the fork thread\'s messages by time', () => {
    expect(logItems(forked, [], 't').map((i) => i.kind === 'message' ? i.message.id : i.kind)).toEqual(['reply', 'sentToMain', 'later'])
  })

  it('shows the fork summary under the message sent to main', () => {
    const el = document.createElement('div')
    document.body.replaceChildren(el)
    const root = createRoot(el)
    try {
      act(() => root.render(<Log items={logItems(forked, [], null)} className="log" empty={null} renderAgent={() => null} />))
      const summary = el.querySelector('.sent-message .fork-summary')!
      expect(summary.textContent).toContain('Summary from the fork')
      expect(summary.textContent).toContain('Renamed a.')
      expect(el.querySelector('.sent-message .you')!.textContent).toBe('Continue with this change')
    } finally { act(() => root.unmount()) }
  })
})

describe('Usage-limit continuation UI', () => {
  it('offers Wait & continue at <time> when resetsAt is known', async () => {
    const el = document.createElement('div')
    document.body.replaceChildren(el)
    const root = createRoot(el)
    const resetsAt = Date.now() + 2 * 3600_000
    const runSchedule = vi.fn<(resumeAt: number) => Promise<void>>(async () => {})
    const notice = {
      id: 'n1',
      threadId: null,
      text: "The turn failed: You've hit your limit",
      afterSeq: 1,
      tone: 'failed' as const,
      action: { label: 'Retry', run: vi.fn(async () => {}) },
      schedule: { resetsAt, run: runSchedule }
    }
    try {
      act(() => root.render(<Log items={logItems(open, [notice], null)} className="log" empty={null} renderAgent={() => null} />))
      const buttons = [...el.querySelectorAll<HTMLButtonElement>('.notice-action')]
      const waitBtn = buttons.find((b) => b.textContent?.startsWith('Wait & continue at'))
      expect(waitBtn).toBeDefined()
      await act(async () => { waitBtn!.click() })
      expect(runSchedule).toHaveBeenCalledExactlyOnceWith(resetsAt + 15_000)
    } finally { act(() => root.unmount()) }
  })

  it('offers manual delay presets and custom time picker when no reset time is reported', async () => {
    const el = document.createElement('div')
    document.body.replaceChildren(el)
    const root = createRoot(el)
    const runSchedule = vi.fn<(resumeAt: number) => Promise<void>>(async () => {})
    const notice = {
      id: 'n2',
      threadId: null,
      text: 'The turn failed: RESOURCE_EXHAUSTED',
      afterSeq: 1,
      tone: 'failed' as const,
      action: { label: 'Retry', run: vi.fn(async () => {}) },
      schedule: { run: runSchedule }
    }
    try {
      act(() => root.render(<Log items={logItems(open, [notice], null)} className="log" empty={null} renderAgent={() => null} />))
      const toggle = [...el.querySelectorAll<HTMLButtonElement>('.notice-action')].find((b) => b.textContent === 'Schedule continue…')
      expect(toggle).toBeDefined()
      act(() => { toggle!.click() })
      expect(el.querySelector('input[type="datetime-local"]')).not.toBeNull()
      const preset = [...el.querySelectorAll<HTMLButtonElement>('.notice-schedule-chips button')].find((b) => b.textContent === 'In 1h')
      expect(preset).toBeDefined()
      const before = Date.now()
      await act(async () => { preset!.click() })
      expect(runSchedule).toHaveBeenCalledTimes(1)
      const scheduledMs = runSchedule.mock.calls[0][0]
      expect(scheduledMs).toBeGreaterThanOrEqual(before + 60 * 60_000 - 1000)
    } finally { act(() => root.unmount()) }
  })

  it('shows a scheduled continue inside the failed notice, with only Cancel', async () => {
    const el = document.createElement('div')
    document.body.replaceChildren(el)
    const root = createRoot(el)
    const cancel = vi.fn(async () => {})
    ;(window as unknown as { gloss: unknown }).gloss = { continueAtLimit: { cancel } }
    const withSchedule: OpenSession = {
      ...open,
      scheduledContinues: [{ sessionId: 's', scheduled: { threadId: null, resumeAt: Date.now() + 90 * 60_000, automatic: true } }]
    }
    const notice = {
      id: 'n3',
      threadId: null,
      text: "The turn failed: You've hit your limit",
      afterSeq: 1,
      tone: 'failed' as const,
      action: { label: 'Retry', run: vi.fn(async () => {}) },
      schedule: { resetsAt: Date.now() + 90 * 60_000, run: vi.fn(async () => {}) }
    }
    try {
      act(() => root.render(<Log items={logItems(withSchedule, [notice], null)} className="log" empty={null} renderAgent={() => null} />))
      const boxes = el.querySelectorAll('.notice.failed')
      expect(boxes).toHaveLength(1)
      expect(boxes[0].textContent).toContain('Hit your usage limit. Continuing at')
      expect(boxes[0].textContent).not.toContain('The turn failed')
      const labels = [...boxes[0].querySelectorAll('button')].map((b) => b.textContent)
      expect(labels).toEqual(['Cancel'])
      await act(async () => { boxes[0].querySelector('button')!.click() })
      expect(cancel).toHaveBeenCalledWith('s')
    } finally { act(() => root.unmount()) }
  })
})
