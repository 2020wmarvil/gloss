// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { Log, type LogItem } from './Log'

const idle = vi.hoisted(() => [] as { run(): void; cancelled: boolean }[])
vi.mock('./idle', () => ({ afterPaintIdle: (run: () => void) => {
  const task = { run, cancelled: false }
  idle.push(task)
  return () => { task.cancelled = true }
} }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const items: LogItem[] = Array.from({ length: 24 }, (_, i) => ({
  kind: 'message', seq: i,
  message: { id: `m${i}`, sessionId: 'history', seq: i, role: 'agent', text: `message ${i}`, threadId: null, createdAt: i }
}))

it('mounts the composer before large history, loads recent entries first, and preserves mounted rows across batches', () => {
  idle.length = 0
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  const root = createRoot(el)
  const render = (reveal?: { messageId: string; key: number }) => act(() => root.render(
    <Log scrollKey="history:main" items={items} className="log" empty={null} renderAgent={(m) => <span>{m.text}</span>} footer={<textarea defaultValue="draft" />} reveal={reveal} />
  ))
  try {
    render()
    const composer = el.querySelector('textarea')!
    expect(composer.value).toBe('draft')
    expect(el.querySelectorAll('[data-message-id]')).toHaveLength(0)
    act(() => idle.find((t) => !t.cancelled)!.run())
    expect(el.querySelectorAll('[data-message-id]')).toHaveLength(8)
    expect(el.querySelector('[data-message-id="m23"]')).not.toBeNull()
    const row = el.querySelector('[data-message-id="m23"]')!
    composer.value = 'typed during startup'
    act(() => idle.find((t) => !t.cancelled)!.run())
    expect(el.querySelectorAll('[data-message-id]')).toHaveLength(16)
    expect(el.querySelector('[data-message-id="m23"]')).toBe(row)
    expect(el.querySelector('textarea')).toBe(composer)
    expect(composer.value).toBe('typed during startup')
    render({ messageId: 'm0', key: 1 })
    expect(el.querySelectorAll('[data-message-id]')).toHaveLength(24)
    expect(el.querySelector('[data-message-id="m0"]')!.className).toContain('revealed')
    render()
    expect(el.querySelectorAll('[data-message-id]')).toHaveLength(24)
  } finally { act(() => root.unmount()) }
  expect(idle.every((t) => t.cancelled)).toBe(true)
})

it('keeps new messages visible while older history is still loading', () => {
  idle.length = 0
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  const root = createRoot(el)
  const render = (entries: LogItem[]) => act(() => root.render(<Log scrollKey="stream:main" items={entries} className="log" empty={null} renderAgent={(m) => m.text} />))
  try {
    render(items)
    const next: LogItem = { kind: 'message', seq: 24, message: { ...(items[23] as Extract<LogItem, { kind: 'message' }>).message, id: 'new', seq: 24, text: 'live reply' } }
    render([...items, next])
    expect(el.querySelector('[data-message-id="new"]')?.textContent).toBe('live reply')
    expect(el.querySelector('[data-message-id="m0"]')).toBeNull()
  } finally { act(() => root.unmount()) }
})

it('preserves the visible message when older entries are prepended above a scrolled viewport', () => {
  idle.length = 0
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  const root = createRoot(el)
  let addedOlder = false
  try {
    act(() => root.render(<Log scrollKey="scroll:main" items={items} className="log" empty={null} renderAgent={(m) => {
      if (m.id === 'm8') addedOlder = true
      return m.text
    }} />))
    act(() => idle.find((t) => !t.cancelled)!.run())
    const scroller = el.querySelector<HTMLElement>('.log-scroll')!
    const anchor = el.querySelector<HTMLElement>('[data-message-id="m18"]')!
    Object.defineProperties(scroller, { clientHeight: { get: () => 300 }, scrollHeight: { get: () => 800 } })
    scroller.getBoundingClientRect = () => ({ top: 100 } as DOMRect)
    anchor.getBoundingClientRect = () => ({ top: addedOlder ? 420 : 120, bottom: addedOlder ? 440 : 140 } as DOMRect)
    scroller.scrollTop = 40
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))
    act(() => idle.find((t) => !t.cancelled)!.run())
    expect(scroller.scrollTop).toBe(340)
    expect(el.querySelector('[data-message-id="m18"]')).toBe(anchor)
  } finally { act(() => root.unmount()) }
})

it('does not measure scroll height on unrelated rerenders', () => {
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  const root = createRoot(el)
  const render = (footer: string) => act(() => root.render(<Log items={items.slice(-1)} className="log" empty={null} renderAgent={(m) => m.text} footer={footer} />))
  try {
    render('before')
    const read = vi.fn(() => 100)
    Object.defineProperty(el.querySelector('.log-scroll'), 'scrollHeight', { get: read })
    render('metadata update')
    expect(read).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()) }
})
