// @vitest-environment jsdom
// SPEC → Performance: a streamed chunk renders only the message it changed.
import { act } from 'react'
import type { GlossEvent } from '@shared/ipc'
import type { Message, Thread } from '@shared/types'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
})

/** Renders of each Markdown text and each screenshot, counted by spies around the real components. */
const renders = vi.hoisted(() => ({ markdown: [] as string[], figures: [] as string[] }))
vi.mock('./Markdown', async (original) => {
  const { memo } = await import('react')
  const real = await original<typeof import('./Markdown')>()
  const Markdown = memo(function Spy(props: Parameters<typeof real.Markdown>[0]) {
    renders.markdown.push(props.text)
    return <real.Markdown {...props} />
  })
  return { ...real, Markdown }
})
vi.mock('./CaptureFigure', async (original) => {
  const real = await original<typeof import('./CaptureFigure')>()
  const CaptureFigure = (props: Parameters<typeof real.CaptureFigure>[0]): React.JSX.Element => {
    renders.figures.push(`${props.message.id}:${props.index}`)
    return <real.CaptureFigure {...props} />
  }
  return { ...real, CaptureFigure }
})
vi.mock('./chime', () => ({ playChime: vi.fn() }))
import { App } from './App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); vi.unstubAllGlobals() })

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

it('renders only the streaming message for each chunk, not the rest of the log', async () => {
  const session = { id: 's', title: 's', cwd: '/project', agentId: 'claude', createdAt: 1 }
  const messages: Message[] = []
  const threads: Thread[] = []
  for (let i = 0; i < 6; i++) {
    messages.push({
      id: `u${i}`, sessionId: 's', seq: messages.length, role: 'user', text: `Question ${i}`, threadId: null,
      ...(i % 2 === 0 ? { attachments: [{ kind: 'image' as const, name: 'shot.png', mimeType: 'image/png', data: PNG, pins: [{ x: 0, y: 0, note: 'here' }] }] } : {})
    })
    messages.push({ id: `a${i}`, sessionId: 's', seq: messages.length, role: 'agent', text: `Answer ${i} with some words in it`, threadId: null })
    threads.push({ id: `t${i}`, sessionId: 's', anchorMessageId: `a${i}`, anchor: { kind: 'selection', start: 9, end: 13, text: 'some' }, createdAt: 1 })
  }
  messages.push({ id: 'r', sessionId: 's', seq: messages.length, role: 'user', text: 'A reply', threadId: 't2' })
  const listeners: ((event: GlossEvent) => void)[] = []
  window.gloss = {
    history: async () => [],
    settings: { get: async () => ({ global: { defaultAgent: 'claude', theme: 'light', sessionOrder: 'created', externalEditor: '', mcpServers: [] }, projects: {}, error: null, path: '/settings.json' }) },
    agents: { rateLimits: async () => ({}), list: async () => [{ id: 'claude', name: 'Claude Code' }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: async () => [] },
    sessions: {
      list: async () => [session],
      refresh: async () => {},
      open: async () => ({
        session, toolCalls: [], plans: [], messages, threads, turn: { threadId: null }, forks: [],
        live: { attached: true, model: null, effort: null, commands: [], usage: null, rateLimits: [], modes: null, autoApprove: false, accepts: { image: false, file: false }, steering: false },
        queue: { items: [], paused: false }
      })
    },
    git: { status: async () => null, pullRequest: async () => null },
    onEvent: (listener: (event: GlossEvent) => void) => { listeners.push(listener); return () => {} }
  } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<App />))
  expect(el.querySelectorAll('.log [data-message-id]')).toHaveLength(12)
  expect(el.querySelectorAll('.log .anchored[data-thread]')).toHaveLength(6)
  expect(renders.figures.length).toBeGreaterThan(0)

  const emit = (event: GlossEvent): void => listeners.forEach((l) => l(event))
  await act(async () => emit({ type: 'message', message: { id: 'live', sessionId: 's', seq: 99, role: 'agent', text: 'Streaming', threadId: null } }))
  renders.markdown.length = 0
  renders.figures.length = 0
  let text = 'Streaming'
  for (let i = 0; i < 20; i++) {
    await act(async () => emit({ type: 'messageText', sessionId: 's', messageId: 'live', threadId: null, offset: text.length, text: ` chunk${i}` }))
    text += ` chunk${i}`
  }
  expect(el.querySelector('.log [data-message-id="live"]')?.textContent).toBe(text)
  // One render per chunk, of the streaming message only: no other answer, question or screenshot.
  expect(renders.figures).toEqual([])
  expect(renders.markdown).toHaveLength(20)
  expect(renders.markdown.every((t) => t.startsWith('Streaming'))).toBe(true)

  // A reply in a thread changes only its anchor message's row.
  await act(async () => emit({ type: 'message', message: { id: 'r2', sessionId: 's', seq: 100, role: 'user', text: 'Another reply', threadId: 't4' } }))
  expect(renders.markdown.filter((t) => !t.startsWith('Streaming'))).toEqual(['Answer 4 with some words in it'])
  expect(el.querySelector('.log [data-message-id="a4"] .anchor-chip')?.textContent).toBe('1')
})

it('ignores an addition that does not continue the message where it ends', async () => {
  const { appendText } = await import('@shared/streaming')
  const messages: Message[] = [{ id: 'm', sessionId: 's', seq: 0, role: 'agent', text: 'abc', threadId: null }]
  expect(appendText(messages, 'm', 3, 'def')[0].text).toBe('abcdef')
  expect(appendText(messages, 'm', 1, 'xyz')).toBe(messages)
  expect(appendText(messages, 'other', 0, 'xyz')).toBe(messages)
})

it('loads a screenshot a session view left out when it shows, once', async () => {
  const { CaptureFigure } = await import('./CaptureFigure')
  const image = vi.fn(async () => PNG)
  window.gloss = { sessions: { image } } as unknown as typeof window.gloss
  const message: Message = { id: 'shot', sessionId: 's', seq: 0, role: 'user', text: '', threadId: null, attachments: [{ kind: 'image', name: 's.png', mimeType: 'image/png', data: '', deferred: true }] }
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  const figure = message.attachments![0] as Extract<NonNullable<Message['attachments']>[number], { kind: 'image' }>
  await act(async () => root!.render(<CaptureFigure message={message} image={figure} index={0} />))
  expect(image).toHaveBeenCalledWith('shot', 0)
  expect(el.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
  // Shown again (another mount, a new view of the same message): no second request.
  await act(async () => root!.render(<div />))
  await act(async () => root!.render(<CaptureFigure message={{ ...message }} image={{ ...figure }} index={0} />))
  expect(image).toHaveBeenCalledTimes(1)
  expect(el.querySelector('img')).not.toBeNull()
})
