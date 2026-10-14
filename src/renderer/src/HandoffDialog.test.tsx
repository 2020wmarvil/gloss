// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { HandoffDialog } from './HandoffDialog'
import type { OpenSession } from './App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => act(() => root?.unmount()))
const open: OpenSession = {
  session: { id: 's', agentId: 'claude', acpSessionId: 'a', cwd: '/project', title: 'Cache work', createdAt: 1 },
  messages: [
    { id: 'main', sessionId: 's', seq: 0, role: 'user', threadId: null, text: 'Main discussion' },
    { id: 'm1', sessionId: 's', seq: 1, role: 'user', threadId: 't', text: 'Use the helper' },
    { id: 'm2', sessionId: 's', seq: 2, role: 'agent', threadId: 't', text: 'Next step: test cache invalidation' }
  ], threads: [{ id: 't', sessionId: 's', anchorMessageId: 'anchor', anchor: { kind: 'selection', start: 0, end: 5, text: 'Cache' }, createdAt: 1 }],
  toolCalls: [], plans: []
}

async function mount(threadId: string | null = 't', handoff = vi.fn(async () => ({ ...open.session, id: 'new', agentId: 'codex' }))): Promise<{ el: HTMLDivElement; close: ReturnType<typeof vi.fn>; created: ReturnType<typeof vi.fn>; handoff: typeof handoff }> {
  window.gloss = { sessions: { handoff } } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  const close = vi.fn(), created = vi.fn()
  await act(async () => root!.render(<HandoffDialog open={open} threadId={threadId} agents={[{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }]} running={false} onClose={close} onCreated={created} />))
  return { el, close, created, handoff }
}

it('previews edited context, restricts thread selection, and creates the requested handoff', async () => {
  const { el, created, handoff } = await mount()
  expect(document.activeElement).toBe(el.querySelector('select'))
  expect(el.querySelectorAll('option')).toHaveLength(1)
  expect(el.querySelector('.handoff-messages')!.textContent).not.toContain('Main discussion')
  const textarea = el.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Continue testing the helper')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1].click()
  })
  const preview = el.querySelector('.handoff-preview pre')!.textContent!
  expect(preview).toContain('Continue testing the helper')
  expect(preview).toContain('Use the helper')
  expect(preview).not.toContain('Next step: test cache invalidation')
  await act(async () => (el.querySelector('footer button') as HTMLButtonElement).click())
  expect(handoff).toHaveBeenCalledWith({ sessionId: 's', threadId: 't', agentId: 'codex', summary: 'Continue testing the helper', messageIds: ['m1'] })
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' }))
})

it('supports a summary-only handoff and keeps the preview on creation errors', async () => {
  const { el, created } = await mount(null, vi.fn().mockRejectedValue(new Error('MCP transport unsupported')))
  const clear = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Clear selection')!
  await act(async () => clear.click())
  expect(el.querySelector('.handoff-preview pre')!.textContent).not.toContain('Selected conversation context')
  await act(async () => (el.querySelector('footer button') as HTMLButtonElement).click())
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('MCP transport unsupported')
  expect(created).not.toHaveBeenCalled()
  expect((el.querySelector('footer button') as HTMLButtonElement).disabled).toBe(false)
})

it('traps focus and handles Escape without reaching the composer', async () => {
  const { el, close } = await mount()
  const outer = vi.fn()
  window.addEventListener('keydown', outer)
  const last = el.querySelector<HTMLButtonElement>('footer button')!
  last.focus()
  await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(el.querySelector('button'))
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(close).toHaveBeenCalled()
  expect(outer).not.toHaveBeenCalled()
  window.removeEventListener('keydown', outer)
})
