// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlossApi } from '@shared/ipc'
import type { PlanUsage } from '@shared/types'
import { formatTokens, StatusLine } from './StatusLine'
import { resetIn } from './UsagePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
const onCommand = vi.fn()
const usage: PlanUsage = { plan: 'Pro', available: true, limits: [{ label: 'Session limit', percent: 100, resetsAt: null }], extraUsage: null }
const props: ComponentProps<typeof StatusLine> = {
  session: { id: 's1', agentId: 'claude', acpSessionId: 'a1', cwd: '/project', title: 'Test', createdAt: 1 },
  live: { attached: true, model: null, effort: null, commands: [{ name: 'usage', description: 'Usage' }],
    usage: { used: 40000, size: 200000 }, rateLimits: [{ window: 'five_hour', status: 'rejected' }],
    modes: null, autoApprove: false, accepts: { image: false, file: false }, steering: false },
  git: null, pr: null, running: false,
  queue: { items: [], paused: false }, onResumeQueue() {}, async onSetChoice() {}, onCommand
}
function mount(fetch: () => Promise<PlanUsage | null>, overrides: Partial<ComponentProps<typeof StatusLine>> = {}): void {
  act(() => root?.unmount())
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
    const labels = [...document.querySelectorAll('.popover-anchor > button')].map((b) => b.textContent || b.querySelector('[aria-label]')?.getAttribute('aria-label'))
    expect(labels.slice(-4)).toEqual(['Opus', 'Medium', 'Ask', 'Extensions'])
    await click('button[title="Effort"]')
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['Medium', 'High'])
    await click('[role="option"]:not([aria-selected="true"])')
    expect(onSetChoice).toHaveBeenCalledWith('effort', 'high')
  })
})


describe('permission mode picker', () => {
  const modes = {
    current: 'default',
    bypass: 'bypassPermissions',
    options: [
      { value: 'default', name: 'Manual', description: 'Always ask before making changes' },
      { value: 'bypassPermissions', name: 'Bypass permissions' }
    ]
  }

  it("picks one of the agent's modes", async () => {
    mount(async () => null, { live: { ...props.live, modes, autoApprove: false } })
    const setMode = vi.fn(async () => {})
    window.gloss.sessions.setMode = setMode
    expect(document.querySelector('.mode-picker')?.textContent).toBe('Manual')
    await click('.mode-picker')
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      'ManualAlways ask before making changes',
      'Bypass permissions'
    ])
    // An agent with a bypass mode has no separate auto-approval.
    expect(document.querySelector('[role="menuitemcheckbox"]')).toBeNull()
    await click('[role="option"]:not([aria-selected="true"])')
    expect(setMode).toHaveBeenCalledWith('s1', 'bypassPermissions')
  })

  it('offers auto-approval for an agent without a bypass mode, and shows when Gloss approves', async () => {
    const plain = { current: 'build', bypass: null, options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] }
    mount(async () => null, { live: { ...props.live, modes: plain, autoApprove: true } })
    const setAutoApprove = vi.fn(async () => {})
    window.gloss.sessions.setAutoApprove = setAutoApprove
    const picker = document.querySelector('.mode-picker')!
    expect(picker.textContent).toBe('Build· auto-approve')
    expect(picker.classList.contains('warn')).toBe(true)
    await click('.mode-picker')
    await click('[role="menuitemcheckbox"]')
    expect(setAutoApprove).toHaveBeenCalledWith('s1', false)
  })

  it('says when the agent is waiting for the user', () => {
    mount(async () => null, { waiting: 1 })
    expect(document.querySelector('.status-item.waiting')?.textContent).toBe('Waiting for you')
  })
})

describe('Obsidian shortcut', () => {
  it('appears beside the folder and reports launch failures', async () => {
    mount(async () => null, { obsidianVault: 'Project notes' })
    const openObsidian = vi.fn().mockRejectedValue(new Error('Obsidian is not installed'))
    window.gloss.sessions.openObsidian = openObsidian
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Open Obsidian vault"]')!
    expect(button.previousElementSibling?.textContent).toBe('project')
    await act(async () => button.click())
    expect(openObsidian).toHaveBeenCalledWith('s1')
    expect(document.body.textContent).toContain("Couldn't open Obsidian: Obsidian is not installed")
    act(() => root!.render(<StatusLine {...props} />))
    expect(document.querySelector('[aria-label="Open Obsidian vault"]')).toBeNull()
    expect(document.body.textContent).not.toContain("Couldn't open Obsidian")
  })

  it('hides the shortcut when the setting is blank', () => {
    mount(async () => null, { obsidianVault: '   ' })
    expect(document.querySelector('[aria-label="Open Obsidian vault"]')).toBeNull()
  })
})

describe('status line labels', () => {
  it('names each value', () => {
    mount(async () => null, {
      live: { ...props.live, usage: { used: 40000, size: 1_000_000, cost: { amount: 0.01, currency: 'USD' } },
        rateLimits: [{ window: 'five_hour', status: 'allowed' }], modes: null, autoApprove: true }
    })
    const text = document.querySelector('.status-line')!.textContent
    expect(text).toContain('Context4% of 1M')
    expect(text).toContain('$0.01')
    expect(text).toContain('5h limitOK')
    expect(document.querySelector('.mode-picker')?.textContent).toBe('Auto-approve')
  })

  it('leaves the queued count to the activity strip above it', () => {
    const queue = { items: [{ id: 'q', threadId: null, text: 'next', attachments: [] }], paused: false }
    mount(async () => null, { queue })
    expect(document.querySelector('.queue-count')?.textContent).toBe('1 queued')
    mount(async () => null, { queue, queueShownAbove: true })
    expect(document.querySelector('.queue-count')).toBeNull()
  })
})

it('writes token counts in k and M', () => {
  expect(formatTokens(200_000)).toBe('200k')
  expect(formatTokens(1_000_000)).toBe('1M')
  expect(formatTokens(1_500_000)).toBe('1.5M')
})

describe('status bar keyboard shortcuts', () => {
  function press(key: string, extra: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, ctrlKey: true, altKey: true, bubbles: true, cancelable: true, ...extra })
    act(() => window.dispatchEvent(event))
    return event
  }

  it('opens the current folder and vault once per press and shares launch errors', async () => {
    mount(async () => null, { obsidianVault: 'Notes' })
    const openFolder = vi.fn().mockResolvedValue(null)
    const openObsidian = vi.fn().mockRejectedValue(new Error('missing vault'))
    window.gloss.sessions.openFolder = openFolder
    window.gloss.sessions.openObsidian = openObsidian
    await act(async () => { expect(press('e').defaultPrevented).toBe(true); press('o') })
    expect(openFolder).toHaveBeenCalledWith('s1')
    expect(openObsidian).toHaveBeenCalledWith('s1')
    expect(document.body.textContent).toContain("Couldn't open Obsidian: missing vault")
    expect(openFolder).toHaveBeenCalledTimes(1)
    press('e', { repeat: true })
    expect(openFolder).toHaveBeenCalledTimes(1)
    press('e', { altKey: false })
    expect(openFolder).toHaveBeenCalledTimes(1)
    press('e', { shiftKey: true })
    expect(openFolder).toHaveBeenCalledTimes(1)
    press('e', { isComposing: true })
    expect(openFolder).toHaveBeenCalledTimes(1)
    act(() => root!.render(<StatusLine {...props} session={{ ...props.session, id: 's2' }} />))
    await act(async () => { press('E', { ctrlKey: false, metaKey: true }) })
    expect(openFolder).toHaveBeenLastCalledWith('s2')
    expect(press('o').defaultPrevented).toBe(false)
    act(() => root!.unmount())
    root = null
    expect(press('e').defaultPrevented).toBe(false)
  })

  it('opens the branch and PR links only when available', () => {
    mount(async () => null)
    expect(press('b').defaultPrevented).toBe(false)
    expect(press('p').defaultPrevented).toBe(false)
    act(() => root!.render(<StatusLine {...props}
      git={{ branch: 'dev', dirty: false, url: 'https://github.com/org/repo/tree/dev' }}
      pr={{ number: 7, title: 'Change', url: 'https://github.com/org/repo/pull/7', state: 'open', checks: null, review: null, baseRef: 'main' }} />))
    const opened: string[] = []
    for (const link of document.querySelectorAll<HTMLAnchorElement>('.status-place a')) {
      link.addEventListener('click', (event) => { event.preventDefault(); opened.push(link.href) })
    }
    expect(press('b').defaultPrevented).toBe(true)
    expect(press('p').defaultPrevented).toBe(true)
    expect(opened).toEqual(['https://github.com/org/repo/tree/dev', 'https://github.com/org/repo/pull/7'])
  })
})
