// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlossApi } from '@shared/ipc'
import type { PlanUsage } from '@shared/types'
import { StatusLine } from './StatusLine'
import { resetIn } from './UsagePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
const onCommand = vi.fn()
const usage: PlanUsage = { plan: 'Pro', available: true, limits: [{ label: 'Session limit', percent: 100, resetsAt: null }], extraUsage: null }
const props: ComponentProps<typeof StatusLine> = {
  session: { id: 's1', agentId: 'claude', acpSessionId: 'a1', cwd: '/project', title: 'Test', createdAt: 1 },
  live: { attached: true, model: null, effort: null, commands: [{ name: 'usage', description: 'Usage' }],
    usage: { used: 40000, size: 200000 }, rateLimits: [{ window: 'five_hour', status: 'rejected' }],
    permissions: null, accepts: { image: false, file: false }, steering: false },
  git: null, pr: null, running: false,
  queue: { items: [], paused: false }, onResumeQueue() {}, async onSetChoice() {}, onCommand
}
function mount(fetch: () => Promise<PlanUsage | null>, overrides: Partial<ComponentProps<typeof StatusLine>> = {}): void {
  window.gloss = { sessions: { planUsage: fetch } } as unknown as GlossApi
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  act(() => root!.render(<StatusLine {...props} {...overrides} />))
}
async function click(selector: string): Promise<void> {
  await act(async () => document.querySelector<HTMLButtonElement>(selector)!.click())
}
afterEach(() => { act(() => root?.unmount()); root = null; vi.clearAllMocks() })

describe('usage popup', () => {
  it.each([true, false])('opens Codex usage during a turn, context available: %s', async (hasContext) => {
    const fetch = vi.fn(async () => usage)
    mount(fetch, {
      session: { ...props.session, agentId: 'codex' }, running: true,
      live: { ...props.live, commands: [{ name: 'status', description: 'Status' }],
        usage: hasContext ? props.live.usage : null, rateLimits: [] }
    })
    expect(document.querySelector('.usage-trigger')?.textContent).toContain(hasContext ? '20%' : 'Usage')
    expect(fetch).not.toHaveBeenCalled()
    await click('.usage-trigger')
    expect(fetch).toHaveBeenCalledWith('s1')
    expect(document.querySelector('[aria-label="Session limit"]')).not.toBeNull()
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('fetches only on open, works during a turn, and never sends a command', async () => {
    let resolve!: (value: PlanUsage) => void
    const fetch = vi.fn(() => new Promise<PlanUsage>((r) => { resolve = r }))
    mount(fetch)
    expect(fetch).not.toHaveBeenCalled()
    await click('.usage-trigger')
    expect(document.body.textContent).toContain('Loading plan usage')
    expect(fetch).toHaveBeenCalledWith('s1')
    await act(async () => resolve(usage))
    expect(document.querySelector('[aria-label="Context window"]')?.getAttribute('aria-valuenow')).toBe('20')
    expect(document.querySelector('[aria-label="Session limit"]')?.getAttribute('aria-valuenow')).toBe('100')
    expect(document.body.textContent).toContain('Pro')
    expect(onCommand).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('.usage-panel')).toBeNull()
    await click('.usage-trigger')
    act(() => document.body.click())
    expect(document.querySelector('.usage-panel')).toBeNull()
  })

  it('keeps failures in the popup and retries without adding a message', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(usage)
    mount(fetch)
    await click('.usage-trigger')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('offline')
    await click('.usage-panel button')
    expect(document.querySelector('[aria-label="Session limit"]')).not.toBeNull()
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('closes on session changes and ignores a late response from the old session', async () => {
    let resolve!: (value: PlanUsage) => void
    mount(() => new Promise((r) => { resolve = r }))
    await click('.usage-trigger')
    act(() => root!.render(<StatusLine {...props} session={{ ...props.session, id: 's2' }} />))
    await act(async () => resolve(usage))
    expect(document.querySelector('.usage-panel')).toBeNull()
  })

  it('explains unavailable limits and formats reset intervals', async () => {
    mount(async () => ({ ...usage, available: false, limits: [] }))
    await click('.usage-trigger')
    expect(document.body.textContent).toContain('Plan limits are unavailable')
    expect(resetIn(100, 100)).toBe('Resets soon')
    expect(resetIn(61 * 60000, 0)).toBe('Resets in 1 hr 1 min')
  })
})

describe('effort picker', () => {
  it('shows the effort after the model and sets the one picked', async () => {
    const onSetChoice = vi.fn(async () => {})
    window.gloss = {} as unknown as GlossApi
    const el = document.createElement('div')
    document.body.replaceChildren(el)
    root = createRoot(el)
    const live = {
      ...props.live,
      model: { configId: 'model', current: 'opus', options: [{ value: 'opus', name: 'Opus' }] },
      effort: { configId: 'effort', current: 'medium', options: [{ value: 'default', name: 'Default' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] }
    }
    act(() => root!.render(<StatusLine {...props} live={live} onSetChoice={onSetChoice} />))
    const labels = [...document.querySelectorAll('.popover-anchor > button')].map((b) => b.textContent)
    expect(labels.slice(-3)).toEqual(['Opus', 'Medium', 'Extensions'])
    await click('button[title="Effort"]')
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['Medium', 'High'])
    await click('[role="option"]:not([aria-selected="true"])')
    expect(onSetChoice).toHaveBeenCalledWith('effort', 'high')
  })
})
