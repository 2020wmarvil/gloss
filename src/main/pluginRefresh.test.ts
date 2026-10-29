import { describe, expect, it, vi } from 'vitest'
import { PluginRefresh } from './pluginRefresh'

/** A refresh queue whose agents are busy while their id is in `busy`; restarts resolve when `release` is called. */
function setup() {
  const busy = new Set<string>()
  const restarts: string[] = []
  const refreshed: string[] = []
  let release: (() => void) | undefined
  let hold = false
  const refresh = new PluginRefresh({
    restartIdleAgent: async (id) => {
      if (busy.has(id)) return false
      restarts.push(id)
      if (hold) await new Promise<void>((resolve) => { release = resolve })
      return true
    },
    reconcile: vi.fn(),
    markPending: vi.fn(),
    refreshed: (id) => refreshed.push(id),
    changed: vi.fn()
  })
  return {
    refresh, busy, restarts, refreshed,
    holdRestarts: () => { hold = true },
    release: () => { hold = false; release?.() }
  }
}

describe('PluginRefresh', () => {
  it('restarts an idle agent at once', async () => {
    const { refresh, restarts, refreshed } = setup()
    refresh.request(['claude'])
    await vi.waitFor(() => expect(refreshed).toEqual(['claude']))
    expect(restarts).toEqual(['claude'])
  })

  it('waits for a busy agent to end its turn', async () => {
    const { refresh, busy, restarts, refreshed } = setup()
    busy.add('codex')
    refresh.request(['codex'])
    await Promise.resolve()
    expect(restarts).toEqual([])
    busy.clear()
    refresh.retry()
    await vi.waitFor(() => expect(refreshed).toEqual(['codex']))
  })

  it('restarts again for a change made while the agent was restarting', async () => {
    const t = setup()
    t.holdRestarts()
    t.refresh.request(['claude'])
    await vi.waitFor(() => expect(t.restarts).toEqual(['claude']))
    // The restart is in flight: this change came after the agent read its plugins.
    t.refresh.request(['claude'])
    t.release()
    await vi.waitFor(() => expect(t.refreshed).toEqual(['claude']))
    expect(t.restarts).toEqual(['claude', 'claude'])
  })

  it('takes an agent requested while another one restarts', async () => {
    const t = setup()
    t.holdRestarts()
    t.refresh.request(['claude'])
    await vi.waitFor(() => expect(t.restarts).toEqual(['claude']))
    t.refresh.request(['codex'])
    t.release()
    await vi.waitFor(() => expect(t.refreshed.sort()).toEqual(['claude', 'codex']))
  })
})
