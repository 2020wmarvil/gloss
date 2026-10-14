// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { HandoffDialog } from './HandoffDialog'
import type { PreparedHandoff } from '@shared/handoff'
import type { OpenSession } from './App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => act(() => root?.unmount()))
const open: OpenSession = {
  session: { id: 's', agentId: 'claude', acpSessionId: 'a', cwd: '/project', title: 'Cache work', createdAt: 1 },
  messages: [], threads: [], toolCalls: [], plans: []
}
const draft: PreparedHandoff = { id: 'prepared', summary: 'Continue testing the cache helper.', summaryKind: 'agent', transcriptPath: '/data/handoffs/snapshot.md', prompt: 'Continue testing the cache helper. Read /data/handoffs/snapshot.md for context.' }
const flush = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 10)) })

async function mount(prepare = vi.fn(async (): Promise<PreparedHandoff> => draft), handoff = vi.fn(async () => ({ ...open.session, id: 'new', agentId: 'codex' }))): Promise<{
  el: HTMLDivElement; close: ReturnType<typeof vi.fn>; created: ReturnType<typeof vi.fn>; prepare: typeof prepare; handoff: typeof handoff;
  cancel: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn>
}> {
  const cancel = vi.fn(async () => {}), discard = vi.fn(async () => {})
  window.gloss = { sessions: { handoff, prepareHandoff: prepare, cancelHandoffPreparation: cancel, discardHandoff: discard } } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  const close = vi.fn(), created = vi.fn()
  await act(async () => root!.render(<StrictMode><HandoffDialog open={open} threadId="t" agents={[{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }]} onClose={close} onCreated={created} /></StrictMode>))
  await flush()
  return { el, close, created, prepare, handoff, cancel, discard }
}

it('generates one summary in StrictMode, shows a fixed preview and creates the reviewed handoff', async () => {
  const { el, created, handoff, prepare } = await mount()
  expect(prepare).toHaveBeenCalledExactlyOnceWith('s', 't')
  expect(document.activeElement).toBe(el.querySelector('select'))
  expect(el.querySelectorAll('option')).toHaveLength(1)
  expect(el.querySelector('textarea')).toBeNull()
  expect(el.querySelector('input')).toBeNull()
  expect(el.querySelector('.handoff-summary')!.textContent).toContain(draft.summary)
  expect(el.querySelector('.handoff-preview pre')!.textContent).toBe(draft.prompt)
  await act(async () => (el.querySelector('footer button') as HTMLButtonElement).click())
  expect(handoff).toHaveBeenCalledWith({ preparedId: 'prepared', agentId: 'codex' })
  expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: 'new' }))
})

it('shows the usage fallback and retries destination creation without spending another summary turn', async () => {
  const { el, prepare, created, handoff } = await mount(
    vi.fn(async () => ({ ...draft, summaryKind: 'blurb' as const, fallbackReason: 'usage' as const })),
    vi.fn().mockRejectedValueOnce(new Error('MCP transport unsupported')).mockResolvedValue({ ...open.session, id: 'new' })
  )
  expect(el.querySelector('[role="status"]')!.textContent).toContain('hit a usage limit')
  await act(async () => (el.querySelector('footer button') as HTMLButtonElement).click())
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('MCP transport unsupported')
  expect(created).not.toHaveBeenCalled()
  await act(async () => (el.querySelector('footer button') as HTMLButtonElement).click())
  expect(handoff).toHaveBeenCalledTimes(2)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(created).toHaveBeenCalled()
})

it('disables Continue during summary generation and cancels preparation when dismissed', async () => {
  let finish!: (p: PreparedHandoff) => void
  const { el, cancel, discard } = await mount(vi.fn(() => new Promise<PreparedHandoff>((r) => { finish = r })))
  expect((el.querySelector('footer button') as HTMLButtonElement).disabled).toBe(true)
  expect(el.querySelector('[role="status"]')!.textContent).toContain('Generating a handoff summary')
  await act(async () => root!.unmount())
  root = undefined
  expect(cancel).toHaveBeenCalledExactlyOnceWith('s')
  await act(async () => finish(draft))
  expect(discard).toHaveBeenCalledWith(draft.id)
})

it('reports summary errors and lets the user retry generation', async () => {
  const prepare = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(draft)
  const { el } = await mount(prepare)
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('Connection lost')
  expect((el.querySelector('footer button') as HTMLButtonElement).disabled).toBe(true)
  await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Retry summary')!.click())
  await flush()
  expect(prepare).toHaveBeenCalledTimes(2)
  expect(el.querySelector('[role="alert"]')).toBeNull()
  expect((el.querySelector('footer button') as HTMLButtonElement).disabled).toBe(false)
})

it('traps focus, handles Escape locally and discards unconsumed snapshots on close', async () => {
  const { el, close, discard } = await mount()
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
  await act(async () => root!.unmount())
  root = undefined
  expect(discard).toHaveBeenCalledWith(draft.id)
})
