// @vitest-environment jsdom
// Background jobs and Restart in the sidebar (SPEC → Background jobs, Sidebar).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
})
import { App } from './App'
import { playChime } from './chime'

vi.mock('./chime', () => ({ playChime: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  vi.restoreAllMocks()
})

async function renderApp(): Promise<{ el: HTMLElement; emit(event: object): Promise<void>; restart: ReturnType<typeof vi.fn>; setBadge: ReturnType<typeof vi.fn> }> {
  const session = (id: string, createdAt: number, agentId = 'claude'): object => ({ id, title: id, cwd: '/project', agentId, createdAt })
  const global = { defaultAgent: 'claude', theme: 'light', sessionOrder: 'created', turnEndSound: true, permissionMode: 'bypass' as const, externalEditor: '', mcpServers: {}, agentProfiles: [] }
  const listeners = new Set<(event: object) => void>()
  const restart = vi.fn(async () => {})
  const setBadge = vi.fn()
  window.gloss = {
    history: async () => [],
    settings: { get: async () => ({ global, projects: {}, error: null, path: '/settings.json' }) },
    updates: { state: async () => ({ version: '1.0.0', status: 'unsupported', reason: 'dev' }) },
    agents: { rateLimits: async () => ({}), list: async () => [{ id: 'claude', name: 'Claude Code' }, { id: 'opencode', name: 'OpenCode', available: true }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: async () => [] },
    sessions: {
      list: async () => [session('a', 3), session('b', 2), session('o', 1, 'opencode')],
      refresh: async () => {},
      restart,
      open: async (id: string) => ({
        session: session(id, 3), toolCalls: [], plans: [], turn: null, forks: [], background: [], messages: [], threads: [],
        live: { attached: true, model: null, effort: null, commands: [], usage: null, rateLimits: [], modes: null, autoApprove: false, accepts: { image: false, file: false }, steering: false },
        queue: { items: [], paused: false }, requests: []
      })
    },
    git: { status: async () => null, pullRequest: async () => null },
    setBadge,
    onEvent: (handler: (event: object) => void) => { listeners.add(handler); return () => listeners.delete(handler) }
  } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<App />))
  return { el, restart, setBadge, emit: (event) => act(async () => listeners.forEach((l) => l(event))) }
}

const row = (el: HTMLElement, title: string): HTMLElement => [...el.querySelectorAll<HTMLElement>('.session-row')].find((r) => r.title === title)!
const lead = (el: HTMLElement, title: string): string | undefined => row(el, title).querySelector('.row-lead > span')?.className

async function menuItem(el: HTMLElement, title: string, name: RegExp): Promise<HTMLButtonElement | undefined> {
  if (!row(el, title).querySelector('.row-actions')) await act(async () => row(el, title).querySelector<HTMLButtonElement>('.row-more')!.click())
  return [...row(el, title).querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => name.test(b.textContent ?? ''))
}

it('shows the running dot for a job, and marks and chimes only when the work is over', async () => {
  const { el, emit, setBadge } = await renderApp()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const chime = vi.mocked(playChime)
  chime.mockClear()

  await emit({ type: 'turnStart', sessionId: 'b', threadId: null })
  await emit({ type: 'background', sessionId: 'b', threads: [null] })
  await emit({ type: 'turnEnd', sessionId: 'b', threadId: null, stopReason: 'end_turn', jobsRunning: true })
  expect(lead(el, 'b')).toBe('running-dot')
  expect(chime).not.toHaveBeenCalled()
  expect(setBadge.mock.lastCall?.[0]).toEqual({ state: 'working', unseen: 0 })

  await emit({ type: 'background', sessionId: 'b', threads: [] })
  await emit({ type: 'turnEnd', sessionId: 'b', threadId: null, stopReason: 'end_turn' })
  expect(lead(el, 'b')).toBe('done-dot')
  expect(chime).toHaveBeenCalledTimes(1)
})

it('restarts a session from its menu, says when that stops its jobs, and waits for a turn', async () => {
  const { el, emit, restart } = await renderApp()

  const idle = await menuItem(el, 'b', /^Restart/)
  expect(idle?.textContent).toBe('Restart')
  expect(idle?.disabled).toBe(false)
  await act(async () => idle!.click())
  expect(restart).toHaveBeenCalledWith('b')
  expect(row(el, 'b').querySelector('.row-actions')).toBeNull()

  await emit({ type: 'background', sessionId: 'b', threads: [null] })
  const withJob = await menuItem(el, 'b', /^Restart/)
  expect(withJob?.textContent).toBe('Restart (stops background jobs)')
  expect(withJob?.disabled).toBe(false)

  // A job's dot isn't a turn, but a turn holds Restart back.
  await emit({ type: 'turnStart', sessionId: 'b', threadId: null })
  expect((await menuItem(el, 'b', /^Restart/))?.disabled).toBe(true)

  // OpenCode's jobs go on after a restart.
  await emit({ type: 'background', sessionId: 'o', threads: [null] })
  expect((await menuItem(el, 'o', /^Restart/))?.textContent).toBe('Restart')
})
