import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentAvailability } from './agentAvailability'
import type { OpenCodeStatus } from '../shared/ipc'

const available: OpenCodeStatus = { available: true, executable: '/opencode', version: '2.0.0', error: null }
afterEach(() => vi.useRealTimers())

describe('optional agent availability', () => {
  it('returns immediately, shares pending work, and publishes the result later', async () => {
    vi.useFakeTimers()
    let finish!: (status: OpenCodeStatus) => void
    const probe = vi.fn(() => new Promise<OpenCodeStatus>((resolve) => { finish = resolve }))
    const changed = vi.fn()
    const catalog = new AgentAvailability(probe, changed)
    expect(catalog.get('one')).toBeUndefined()
    expect(catalog.get('one')).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(probe).toHaveBeenCalledExactlyOnceWith('one')
    finish(available)
    await vi.runAllTimersAsync()
    expect(changed).toHaveBeenCalledExactlyOnceWith('one', available)
    expect(catalog.get('one')).toBe(available)
    vi.advanceTimersByTime(30_001)
    expect(catalog.get('one')).toBe(available)
    await vi.runAllTimersAsync()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('ignores a stale configuration result and lets a manual test supersede pending work', async () => {
    vi.useFakeTimers()
    const finishes: ((status: OpenCodeStatus) => void)[] = []
    const probe = vi.fn(() => new Promise<OpenCodeStatus>((resolve) => finishes.push(resolve)))
    const changed = vi.fn()
    const catalog = new AgentAvailability(probe, changed)
    catalog.get('old')
    await vi.runAllTimersAsync()
    catalog.get('new')
    await vi.runAllTimersAsync()
    finishes[0](available)
    await vi.runAllTimersAsync()
    expect(changed).not.toHaveBeenCalled()
    const manual = { ...available, version: '2.1.0' }
    catalog.set('new', manual)
    finishes[1](available)
    await vi.runAllTimersAsync()
    expect(catalog.get('new')).toBe(manual)
    expect(changed).toHaveBeenCalledExactlyOnceWith('new', manual)
  })

  it('publishes a safe unavailable result when probing fails', async () => {
    vi.useFakeTimers()
    const changed = vi.fn()
    const catalog = new AgentAvailability(async () => { throw new Error('private diagnostics') }, changed)
    catalog.get('bad')
    await vi.runAllTimersAsync()
    expect(catalog.get('bad')).toMatchObject({ available: false })
    expect(JSON.stringify(changed.mock.calls)).not.toContain('private diagnostics')
  })
})
