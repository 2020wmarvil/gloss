// @vitest-environment jsdom
// Session windows (SPEC → Session windows): popping a session out of the main window, the
// main window's view of popped sessions, and the session window itself.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
})
import { App } from './App'
import { SessionWindow } from './SessionWindow'
import { playChime } from './chime'

vi.mock('./chime', () => ({ playChime: vi.fn() }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  vi.restoreAllMocks()
})

const session = (id: string, createdAt: number): object => ({ id, title: id, cwd: '/project', agentId: 'claude', createdAt })
const message = (sessionId: string): object => ({ id: `${sessionId}-m`, sessionId, seq: 0, role: 'agent', text: '- one\n- two', threadId: null })
const thread = (sessionId: string): object => ({
  id: `${sessionId}-t`, sessionId, anchorMessageId: `${sessionId}-m`, anchor: { kind: 'listItem', path: [0], text: 'one' }, createdAt: 1
})
const live = { attached: true, model: null, effort: null, commands: [], usage: null, rateLimits: [], modes: null, autoApprove: false, accepts: { image: false, file: false }, steering: false }
const global = { defaultAgent: 'claude', theme: 'light', sessionOrder: 'created', listItemReplies: false, turnEndSound: true, permissionMode: 'bypass' as const, externalEditor: '', mcpServers: [] }

/** A window.gloss with sessions a (newest), b and c, each with one agent message and a thread on its first item. */
function fakeGloss(extra: object = {}): {
  emit(event: object): void
  opened: ReturnType<typeof vi.fn>
  windows: { popOut: ReturnType<typeof vi.fn>; popIn: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>; toMain: ReturnType<typeof vi.fn> }
} {
  const listeners = new Set<(event: object) => void>()
  const created = { a: 3, b: 2, c: 1 } as Record<string, number>
  const opened = vi.fn(async (id: string) => ({
    session: session(id, created[id]), messages: [message(id)], toolCalls: [], plans: [], threads: [thread(id)], turn: null, live,
    queue: { items: [], paused: false }, requests: []
  }))
  const windows = {
    popOut: vi.fn(async () => {}),
    popIn: vi.fn(async () => {}),
    focus: vi.fn(async () => true),
    toMain: vi.fn(),
    list: async () => ({ popped: [], focused: null }),
    initial: async () => null
  }
  window.gloss = {
    history: async () => [],
    settings: { get: async () => ({ global, projects: {}, error: null, path: '/settings.json' }) },
    agents: { rateLimits: async () => ({}), list: async () => [{ id: 'claude', name: 'Claude Code' }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: async () => [] },
    sessions: { list: async () => [session('a', 3), session('b', 2), session('c', 1)], open: opened, refresh: async () => {} },
    git: { status: async () => null, pullRequest: async () => null },
    setBadge: vi.fn(),
    windows,
    onEvent: (handler: (event: object) => void) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    ...extra
  } as unknown as typeof window.gloss
  return { emit: (event) => listeners.forEach((l) => l(event)), opened, windows }
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(node))
  return el
}

const key = (init: KeyboardEventInit): Promise<void> => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', init)))
const row = (el: HTMLElement, title: string): HTMLElement => [...el.querySelectorAll<HTMLElement>('.session-row')].find((r) => r.title === title)!

it('closes the current session view with Ctrl+W while keeping it available in the sidebar', async () => {
  const { opened } = fakeGloss()
  const el = await render(<App />)
  await act(async () => row(el, 'b').click())
  expect(opened).toHaveBeenLastCalledWith('b')
  await key({ key: 'w', ctrlKey: true, repeat: true })
  expect(el.querySelector('.session-row.on')!.getAttribute('title')).toBe('b')
  await key({ key: 'w', ctrlKey: true })
  expect(el.querySelector('.session-row.on')!.getAttribute('title')).toBe('a')
  expect(row(el, 'b')).toBeDefined()
  await act(async () => row(el, 'b').click())
  expect(opened).toHaveBeenLastCalledWith('b')
})

it('closes a separate session window with Ctrl+W', async () => {
  fakeGloss()
  const close = vi.spyOn(window, 'close').mockImplementation(() => {})
  await render(<SessionWindow sessionId="b" />)
  await key({ key: 'w', ctrlKey: true, shiftKey: true })
  await key({ key: 'w', ctrlKey: true, repeat: true })
  expect(close).not.toHaveBeenCalled()
  await key({ key: 'w', ctrlKey: true })
  expect(close).toHaveBeenCalledOnce()
})

it('pops the open session out with what it shows and goes back to the session before it', async () => {
  const { emit, opened, windows } = await (async () => fakeGloss())()
  const el = await render(<App />)
  expect(opened).toHaveBeenLastCalledWith('a')
  await act(async () => row(el, 'b').click())
  // Open b's thread, then pop b out from its header.
  await act(async () => el.querySelector<HTMLElement>('.reply-badge, [data-thread]')?.click())
  await act(async () => el.querySelector<HTMLButtonElement>('.window-button')!.click())
  expect(windows.popOut).toHaveBeenCalledWith('b', expect.objectContaining({ sideTab: 'threads', expandedFiles: [], drafts: {} }))
  // Back to a, the view before it.
  expect(opened).toHaveBeenLastCalledWith('a')
  expect(el.querySelector('.session-row.on')!.getAttribute('title')).toBe('a')

  // The main process lists it as popped out: the row shows the window icon, and clicking it brings its window forward.
  await act(async () => emit({ type: 'windows', popped: ['b'], focused: 'b' }))
  expect(row(el, 'b').querySelector('.popped-icon')).not.toBeNull()
  const calls = opened.mock.calls.length
  await act(async () => row(el, 'b').click())
  expect(windows.focus).toHaveBeenCalledWith('b')
  expect(opened).toHaveBeenCalledTimes(calls)

  // Page keys remain available for scrolling, even with Ctrl held.
  for (const pageKey of ['PageDown', 'PageUp']) {
    await key({ key: pageKey })
    await key({ key: pageKey, ctrlKey: true })
  }
  expect(opened).toHaveBeenCalledTimes(calls)

  // Ctrl+Tab and Back skip it.
  await key({ key: 'Tab', ctrlKey: true })
  expect(opened).toHaveBeenLastCalledWith('c')
  await key({ key: 'Tab', ctrlKey: true })
  expect(opened).toHaveBeenLastCalledWith('a')
  await key({ key: 'ArrowLeft', altKey: true })
  expect(opened).toHaveBeenLastCalledWith('c')
  await key({ key: 'ArrowLeft', altKey: true })
  expect(opened).toHaveBeenLastCalledWith('a')

  // Returned from its window: it opens here on the thread and panel it showed there.
  await act(async () => emit({ type: 'windows', popped: [], focused: null }))
  await act(async () =>
    emit({ type: 'popIn', sessionId: 'b', state: { threadId: 'b-t', sideOpen: true, general: false, sideTab: 'threads', expandedFiles: [], drafts: { b: { text: 'half a thought', attachments: [] } }, scroll: {} } })
  )
  expect(opened).toHaveBeenLastCalledWith('b')
  expect(el.querySelector('.session-row.on')!.getAttribute('title')).toBe('b')
  expect(el.querySelector('.thread-panel:not(.threads-overview)')).not.toBeNull()
  expect(row(el, 'b').querySelector('.popped-icon')).toBeNull()
})

it('pops a session out from its menu or Ctrl+Shift+O, and hands session-window shortcuts to the main window', async () => {
  const { emit, opened, windows } = fakeGloss()
  const el = await render(<App />)
  await act(async () => row(el, 'c').querySelector<HTMLButtonElement>('.row-more')!.click())
  const item = [...el.querySelectorAll<HTMLButtonElement>('.row-actions [role="menuitem"]')].find((b) => b.textContent === 'Open in new window')!
  await act(async () => item.click())
  // Not open here, so it opens fresh there and this window stays on a.
  expect(windows.popOut).toHaveBeenCalledWith('c', { threadId: null, sideOpen: false, general: false, sideTab: 'threads', expandedFiles: [], drafts: {}, scroll: {} })
  expect(el.querySelector('.session-row.on')!.getAttribute('title')).toBe('a')

  await key({ key: 'O', ctrlKey: true, shiftKey: true })
  expect(windows.popOut).toHaveBeenLastCalledWith('a', expect.anything())
  // Nothing before a: the project's empty state.
  expect(el.querySelector('.empty-state')).not.toBeNull()

  // Ctrl+N pressed in a session window.
  const create = vi.fn(async () => session('d', 4))
  window.gloss.sessions.create = create as unknown as typeof window.gloss.sessions.create
  await act(async () => emit({ type: 'mainAction', action: { kind: 'newSession' } }))
  expect(create).toHaveBeenCalledWith('/project', 'claude')
  await act(async () => emit({ type: 'mainAction', action: { kind: 'search' } }))
  expect(el.querySelector('.search-dialog, [role="dialog"]')).not.toBeNull()
  expect(opened).not.toHaveBeenCalledWith('c')
})

it('opens a new review in its own window unless reviewWindow is off', async () => {
  const { emit, opened, windows } = fakeGloss()
  const createReview = vi.fn(async () => session('r', 4))
  window.gloss.sessions.createReview = createReview as unknown as typeof window.gloss.sessions.createReview
  const el = await render(<App />)
  await key({ key: 'D', ctrlKey: true, shiftKey: true })
  expect(createReview).toHaveBeenCalledWith('/project', 'claude', undefined, null)
  // Its side panel set to open on the general conversation; this window stays on a.
  expect(windows.popOut).toHaveBeenCalledWith('r', { threadId: null, sideOpen: false, general: true, sideTab: 'threads', expandedFiles: [], drafts: {}, scroll: {} })
  expect(opened).not.toHaveBeenCalledWith('r')
  expect(el.querySelector('.session-row.on')!.getAttribute('title')).toBe('a')

  await act(async () => emit({ type: 'settings', state: { global: { ...global, reviewWindow: false }, projects: {}, error: null, path: '/settings.json' } }))
  createReview.mockResolvedValue(session('s', 5))
  await key({ key: 'D', ctrlKey: true, shiftKey: true })
  expect(windows.popOut).toHaveBeenCalledOnce()
  expect(opened).toHaveBeenLastCalledWith('s')
  // Opening it here collapsed the sidebar, which is remembered.
  localStorage.clear()
})

it("doesn't mark or chime a turn that finishes in a focused session window", async () => {
  const { emit } = fakeGloss()
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  const chime = vi.mocked(playChime)
  chime.mockClear()
  const el = await render(<App />)
  await act(async () => emit({ type: 'windows', popped: ['b'], focused: 'b' }))
  await act(async () => emit({ type: 'turnEnd', sessionId: 'b', threadId: null, stopReason: 'end_turn' }))
  expect(row(el, 'b').querySelector('.done-dot')).toBeNull()
  expect(chime).not.toHaveBeenCalled()
  // Its window in the background: unseen, and chimes.
  await act(async () => emit({ type: 'windows', popped: ['b'], focused: null }))
  await act(async () => emit({ type: 'turnEnd', sessionId: 'b', threadId: null, stopReason: 'end_turn' }))
  expect(row(el, 'b').querySelector('.done-dot')).not.toBeNull()
  expect(chime).toHaveBeenCalledTimes(1)
})

it('opens a session window as the main window showed it, returns it there, and hands main-window shortcuts over', async () => {
  const state = { threadId: 'b-t', sideOpen: true, general: false, sideTab: 'threads', expandedFiles: [], drafts: { 'b-m': { text: 'unsent', attachments: [] } }, scroll: { 'b:main': { bottom: true } } }
  const { opened, windows } = fakeGloss()
  window.gloss.windows.initial = async () => ({ sessionId: 'b', state }) as Awaited<ReturnType<typeof window.gloss.windows.initial>>
  const el = await render(<SessionWindow sessionId="b" />)
  expect(opened).toHaveBeenCalledWith('b')
  expect(el.querySelector('.sidebar')).toBeNull()
  expect(el.querySelector('.thread-panel:not(.threads-overview)')).not.toBeNull()
  expect(document.title).toBe('b · Gloss')

  await key({ key: 'n', ctrlKey: true })
  expect(windows.toMain).toHaveBeenLastCalledWith({ kind: 'newSession' })
  await key({ key: 'F', ctrlKey: true, shiftKey: true })
  expect(windows.toMain).toHaveBeenLastCalledWith({ kind: 'search' })
  const forwarded = windows.toMain.mock.calls.length
  for (const pageKey of ['PageDown', 'PageUp']) {
    await key({ key: pageKey })
    await key({ key: pageKey, ctrlKey: true })
  }
  expect(windows.toMain).toHaveBeenCalledTimes(forwarded)
  await key({ key: 'Tab', ctrlKey: true, shiftKey: true })
  expect(windows.toMain).toHaveBeenLastCalledWith({ kind: 'cycleSession', back: true })

  const button = el.querySelector<HTMLButtonElement>('.window-button')!
  expect(button.getAttribute('aria-label')).toBe('Return to main window')
  await act(async () => button.click())
  // Its drafts go back with it.
  expect(windows.popIn).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: 'b-t', sideOpen: true, sideTab: 'threads', drafts: { 'b-m': { text: 'unsent', attachments: [] } }, scroll: expect.objectContaining({ 'b:main': { bottom: true } }) })
  )
  await key({ key: 'O', ctrlKey: true, shiftKey: true })
  expect(windows.popIn).toHaveBeenCalledTimes(2)
})
