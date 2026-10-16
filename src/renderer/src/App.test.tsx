// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
})
import { App } from './App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); vi.unstubAllGlobals() })

it("starts sessions with the default agent or one from the menu, and lists every agent's external sessions", async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const list = vi.fn(async (_path: string, agentId: string) => [{ acpSessionId: 'same-id', title: `${agentId} external` }])
  const create = vi.fn(async () => { throw new Error('creation observed') })
  const importSession = vi.fn(async () => { throw new Error('import observed') })
  const state = { global: { defaultAgent: 'codex', theme: 'light', sessionOrder: 'created', listItemReplies: false, externalEditor: '', mcpServers: [] }, projects: {}, error: null, path: '/settings.json' }
  const update = vi.fn(async (patch: { global: object }) => ({ ...state, global: { ...state.global, ...patch.global } }))
  window.gloss = {
    history: async () => [],
    settings: { get: async () => state, update },
    agents: { list: async () => [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: list },
    sessions: { list: async () => [], create, import: importSession },
    onEvent: () => () => {}
  } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<App />))
  expect(list).toHaveBeenCalledWith('/project', 'codex')
  expect(list).toHaveBeenCalledWith('/project', 'claude')
  expect(el.textContent).toContain('codex external')
  expect(el.textContent).toContain('claude external')
  expect(el.querySelector('.new-session')!.textContent).toContain('Codex')
  await act(async () => (el.querySelector('.new-session') as HTMLButtonElement).click())
  expect(create).toHaveBeenLastCalledWith('/project', 'codex')

  const openMenu = async (): Promise<void> => act(async () => (el.querySelector('.new-session-agents') as HTMLButtonElement).click())
  await openMenu()
  const stars = [...el.querySelectorAll<HTMLButtonElement>('.agent-star')]
  expect(stars.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  await act(async () => [...el.querySelectorAll<HTMLButtonElement>('.agent-item [role="menuitem"]')][0].click())
  expect(create).toHaveBeenLastCalledWith('/project', 'claude')

  await openMenu()
  await act(async () => el.querySelectorAll<HTMLButtonElement>('.agent-star')[0].click())
  expect(update).toHaveBeenCalledWith({ global: { defaultAgent: 'claude' } })
  expect(el.querySelector('.agent-star.on')!.getAttribute('aria-label')).toContain('Claude Code')
  expect(el.querySelector('.new-session')!.textContent).toContain('Claude Code')

  const claudeRow = [...el.querySelectorAll<HTMLButtonElement>('.session-row.agent')].find((b) => b.textContent!.includes('claude external'))!
  await act(async () => claudeRow.click())
  expect(importSession).toHaveBeenCalledWith('/project', 'claude', 'same-id', 'claude external', undefined)
})

it('goes back and forward through the sessions and settings visited with the mouse buttons and Alt+arrows', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const session = (id: string): object => ({ id, title: id, cwd: '/project', agentId: 'claude', createdAt: id === 'a' ? 2 : 1 })
  const opened = vi.fn(async (id: string) => ({
    session: session(id), messages: [], toolCalls: [], plans: [], threads: [], turn: null,
    live: { attached: false, model: null, effort: null, commands: [], usage: null, rateLimits: [], permissions: null, accepts: { image: false, file: false }, steering: false },
    queue: { items: [], paused: false }
  }))
  window.gloss = {
    history: async () => [],
    settings: { get: async () => ({ global: { defaultAgent: 'claude', theme: 'light', sessionOrder: 'created', listItemReplies: false, externalEditor: '', mcpServers: [] }, projects: {}, error: null, path: '/settings.json' }) },
    agents: { list: async () => [{ id: 'claude', name: 'Claude Code' }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: async () => [] },
    sessions: { list: async () => [session('a'), session('b')], open: opened, refresh: async () => {} },
    git: { status: async () => null, pullRequest: async () => null },
    onEvent: () => () => {}
  } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<App />))
  expect(opened).toHaveBeenLastCalledWith('a')
  const row = [...el.querySelectorAll<HTMLElement>('.session-row')].find((r) => r.title === 'b')!
  await act(async () => row.click())
  expect(opened).toHaveBeenLastCalledWith('b')
  const press = (button: number): Promise<void> =>
    act(async () => {
      window.dispatchEvent(new MouseEvent('mousedown', { button }))
      window.dispatchEvent(new MouseEvent('mouseup', { button }))
    })
  await press(3)
  expect(opened).toHaveBeenLastCalledWith('a')
  await press(3)
  expect(opened).toHaveBeenCalledTimes(3)
  await press(4)
  expect(opened).toHaveBeenLastCalledWith('b')
  expect(el.querySelector('.session-row.on')!.getAttribute('title')).toBe('b')

  const key = (init: KeyboardEventInit): Promise<void> => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', init)))
  await key({ key: ',', ctrlKey: true })
  expect(el.querySelector('main.settings')).not.toBeNull()
  await key({ key: 'ArrowLeft', altKey: true })
  expect(el.querySelector('main.settings')).toBeNull()
  expect(el.querySelector('.session-row.on')!.getAttribute('title')).toBe('b')
  await key({ key: 'ArrowLeft', altKey: true })
  expect(opened).toHaveBeenLastCalledWith('a')
  await key({ key: 'ArrowRight', altKey: true })
  await key({ key: 'ArrowRight', altKey: true })
  expect(el.querySelector('main.settings')).not.toBeNull()
})

it('shows where the agent works and what waits, jumps there, and lists the queue in its tab', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const session = { id: 's', title: 's', cwd: '/project', agentId: 'claude', createdAt: 1 }
  const thread = (id: string, text: string, createdAt: number): object => ({
    id, sessionId: 's', anchorMessageId: 'm', anchor: { kind: 'listItem', path: [0], text }, createdAt
  })
  const remove = vi.fn(async () => {})
  window.gloss = {
    history: async () => [],
    settings: { get: async () => ({ global: { defaultAgent: 'claude', theme: 'light', sessionOrder: 'created', listItemReplies: false, externalEditor: '', mcpServers: [] }, projects: {}, error: null, path: '/settings.json' }) },
    agents: { list: async () => [{ id: 'claude', name: 'Claude Code' }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: async () => [] },
    sessions: {
      list: async () => [session],
      refresh: async () => {},
      open: async () => ({
        session, toolCalls: [], plans: [],
        messages: [
          { id: 'u1', sessionId: 's', seq: 1, role: 'user', text: 'first in main', threadId: null },
          { id: 'u2', sessionId: 's', seq: 2, role: 'user', text: 'in the thread', threadId: 't1' }
        ],
        threads: [thread('late', 'Second thread', 20), thread('t1', 'Make forward and backward buttons work in the app', 10)],
        turn: { threadId: 't1' },
        live: { attached: true, model: null, effort: null, commands: [], usage: null, rateLimits: [], permissions: null, accepts: { image: false, file: false }, steering: false },
        queue: { items: [{ id: 'q1', threadId: 't1', text: 'then this', attachments: [] }, { id: 'q2', threadId: null, text: 'main next', attachments: [] }], paused: false }
      })
    },
    queue: { remove, edit: async () => {}, resume: async () => {} },
    git: { status: async () => null, pullRequest: async () => null },
    onEvent: () => () => {}
  } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<App />))

  const strip = el.querySelector('.activity-strip')!
  expect(strip.textContent).toContain('Working in “Make forward and backward buttons work…”')
  expect(strip.textContent).toContain('2 queued')
  // The turn runs in a thread: the main composer can only queue.
  expect(el.querySelector('.composer .cancel')).toBeNull()

  const key = (init: KeyboardEventInit): Promise<void> => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', init)))
  await key({ key: 'j', ctrlKey: true })
  expect(el.querySelector('aside[aria-label="Thread"]')).not.toBeNull()
  expect(el.querySelector('.thread-composer .cancel')).not.toBeNull()
  // The strip stays while the thread is open.
  expect(el.querySelector('.activity-thread')!.textContent).toContain('Working in')

  await key({ key: 'Q', ctrlKey: true, shiftKey: true })
  expect(el.querySelector('.side-tabs [aria-selected="true"]')!.textContent).toContain('Queue')
  // Queued messages on top, the next one at the bottom; then what was sent, newest (working) first.
  const rows = [...el.querySelectorAll('.queue-list li.queued')]
  expect(rows.map((r) => r.querySelector('.queued-where')!.textContent!.trim())).toEqual([
    'Main conversation',
    'Make forward and backward buttons work…'
  ])
  const sent = [...el.querySelectorAll('.queue-list .sent-row')]
  expect(sent.map((r) => r.querySelector('.sent-text')!.textContent)).toEqual(['in the thread', 'first in main'])
  expect(sent[0].className).toContain('working')
  expect(sent[0].querySelector('.state-dot')!.getAttribute('data-state')).toBe('working')
  expect(rows[0].querySelector('.state-dot')!.getAttribute('data-state')).toBe('queued')
  await act(async () => (rows[0].querySelector('[aria-label="Remove queued message"]') as HTMLButtonElement).click())
  expect(remove).toHaveBeenCalledWith('s', 'q2')

  // A sent message opens where it is, scrolled to and highlighted; ← goes back to the queue.
  await act(async () => (sent[0].querySelector('button') as HTMLButtonElement).click())
  expect(el.querySelector('.thread-panel [data-message-id="u2"]')!.className).toContain('revealed')
  await act(async () => (el.querySelector('.thread-panel .back') as HTMLButtonElement).click())
  expect(el.querySelector('.side-tabs [aria-selected="true"]')!.textContent).toContain('Queue')
  await act(async () => (el.querySelectorAll('.queue-list .sent-row button')[1] as HTMLButtonElement).click())
  expect(el.querySelector('.log [data-message-id="u1"]')!.className).toContain('revealed')

  await act(async () => (el.querySelectorAll('.queue-list li.queued .queued-text')[1] as HTMLElement).click())
  expect(el.querySelector('aside[aria-label="Thread"]')).not.toBeNull()

  // Hiding the panel and showing it again comes back to the same thread.
  await key({ key: 'T', ctrlKey: true, shiftKey: true })
  expect(el.querySelector('.thread-panel')).toBeNull()
  await key({ key: 'T', ctrlKey: true, shiftKey: true })
  expect(el.querySelector('aside[aria-label="Thread"]')).not.toBeNull()

  // Escape no longer hides the side panel.
  await key({ key: 'Escape' })
  expect(el.querySelector('aside[aria-label="Thread"]')).not.toBeNull()
  await act(async () => (el.querySelector('.thread-panel .back') as HTMLButtonElement).click())
  await act(async () => (el.querySelector('.side-tabs [role="tab"]') as HTMLButtonElement).click())
  const threads = [...el.querySelectorAll('.thread-row .thread-quote')].map((q) => q.textContent)
  expect(threads).toEqual(['Make forward and backward buttons work in the app', 'Second thread'])
})

it('remembers each session\'s thread and jumps to where the agent last worked', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const session = (id: string, createdAt: number): object => ({ id, title: id, cwd: '/project', agentId: 'claude', createdAt })
  const views: Record<string, object> = {
    a: {
      messages: [
        { id: 'a1', sessionId: 'a', seq: 1, role: 'user', text: 'in main', threadId: null },
        { id: 'a2', sessionId: 'a', seq: 2, role: 'user', text: 'in thread', threadId: 't1', outcome: 'cancelled' }
      ],
      threads: [{ id: 't1', sessionId: 'a', anchorMessageId: 'x', anchor: { kind: 'listItem', path: [0], text: 'The item' }, createdAt: 1 }]
    },
    b: { messages: [{ id: 'b1', sessionId: 'b', seq: 1, role: 'user', text: 'only main', threadId: null }], threads: [] }
  }
  window.gloss = {
    history: async () => [],
    settings: { get: async () => ({ global: { defaultAgent: 'claude', theme: 'light', sessionOrder: 'created', listItemReplies: false, externalEditor: '', mcpServers: [] }, projects: {}, error: null, path: '/settings.json' }) },
    agents: { list: async () => [{ id: 'claude', name: 'Claude Code' }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: async () => [] },
    sessions: {
      list: async () => [session('a', 2), session('b', 1)],
      refresh: async () => {},
      open: async (id: string) => ({
        session: session(id, id === 'a' ? 2 : 1), toolCalls: [], plans: [], turn: null, ...views[id],
        live: { attached: true, model: null, effort: null, commands: [], usage: null, rateLimits: [], permissions: null, accepts: { image: false, file: false }, steering: false },
        queue: { items: [], paused: false }
      })
    },
    git: { status: async () => null, pullRequest: async () => null },
    onEvent: () => () => {}
  } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<App />))
  const key = (init: KeyboardEventInit): Promise<void> => act(async () => void window.dispatchEvent(new KeyboardEvent('keydown', init)))
  const select = (title: string): Promise<void> =>
    act(async () => [...el.querySelectorAll<HTMLElement>('.session-row')].find((r) => r.title === title)!.click())
  const settle = (): Promise<void> => act(() => new Promise<void>((r) => setTimeout(r, 5)))

  // Idle: the strip and Ctrl+J point at the thread of the last message sent in one.
  expect(el.querySelector('.activity-thread')!.textContent).toContain('Cancelled in “The item”')
  expect(el.querySelector('.activity-thread .state-dot')!.getAttribute('data-state')).toBe('cancelled')
  await key({ key: 'j', ctrlKey: true })
  expect(el.querySelector('.thread-panel .anchor-quote')!.textContent).toContain('The item')

  await select('b')
  expect(el.querySelector('aside[aria-label="Thread"]')).toBeNull()
  // No thread ever worked here: no strip.
  expect(el.querySelector('.activity-strip')).toBeNull()
  // The last message was in the main conversation: its composer gets the caret.
  await key({ key: 'j', ctrlKey: true })
  await settle()
  expect(document.activeElement?.closest('.composer')).not.toBeNull()

  await select('a')
  expect(el.querySelector('.thread-panel .anchor-quote')!.textContent).toContain('The item')
})

it('opens search anywhere and reveals matches in another session, its thread, or tool output', async () => {
  const session = (id: string): object => ({ id, title: id, cwd: '/project', agentId: 'claude', createdAt: 1 })
  const thread = { id: 't', sessionId: 'b', anchorMessageId: 'anchor', anchor: { kind: 'selection', text: 'cache', start: 0, end: 5 }, createdAt: 1 }
  const opened = vi.fn(async (id: string) => ({
    session: session(id),
    messages: id === 'a' ? [] : [
      { id: 'anchor', sessionId: id, seq: 0, role: 'agent', text: 'cache format', threadId: null },
      { id: 'reply', sessionId: id, seq: 1, role: 'agent', text: 'cache thread response', threadId: 't' }
    ],
    toolCalls: id === 'a' ? [] : [{ id: 'tool', sessionId: id, messageSeq: 2, threadId: 't', title: 'Read cache', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'cache tool output' } }] }],
    plans: [], threads: id === 'a' ? [] : [thread], turn: null,
    live: { attached: false, model: null, effort: null, commands: [], usage: null, rateLimits: [], permissions: null, accepts: { image: false, file: false }, steering: false },
    queue: { items: [], paused: false }
  }))
  const search = vi.fn(async () => ({ results: [
    { id: 'reply', kind: 'agent', threadId: 't' }, { id: 'tool', kind: 'tool', threadId: 't' }, { id: 'anchor', kind: 'agent', threadId: null }
  ].map((r) => ({ ...r, sessionId: 'b', sessionTitle: 'b', cwd: '/project', threadQuote: r.threadId ? 'cache' : null, snippet: 'cache match' })), more: false }))
  window.gloss = {
    search, history: async () => [],
    settings: { get: async () => ({ global: { defaultAgent: 'claude', theme: 'light', sessionOrder: 'created', listItemReplies: false, externalEditor: '', mcpServers: [] }, projects: {}, error: null, path: '/settings.json' }) },
    agents: { list: async () => [{ id: 'claude', name: 'Claude Code' }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: async () => [] },
    sessions: { list: async () => [session('a'), session('b')], open: opened, refresh: async () => {} },
    git: { status: async () => null, pullRequest: async () => null }, onEvent: () => () => {}
  } as unknown as typeof window.gloss
  vi.stubGlobal('CSS', { escape: (value: string) => value })
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<App />))
  for (const [index, target] of [[0, 'reply'], [1, 'tool:tool'], [2, 'anchor']] as const) {
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true })))
    const input = el.querySelector<HTMLInputElement>('[aria-label="Search conversations"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'cache')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 180)))
    await act(async () => (el.querySelectorAll('.search-result')[index] as HTMLButtonElement).click())
    expect(opened).toHaveBeenLastCalledWith('b')
    expect(el.querySelector(`[data-message-id="${target}"]`)!.classList.contains('revealed')).toBe(true)
    expect(el.querySelector('.search-dialog')).toBeNull()
    if (index === 1) expect(el.querySelector('.tool.open')!.textContent).toContain('cache tool output')
    if (index === 2) expect(el.querySelector('[aria-label="Thread"]')).toBeNull()
  }
})
