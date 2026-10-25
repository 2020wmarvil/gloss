// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RewindDialog } from './RewindDialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('browses session messages by keyboard and rewinds immediately on selection', async () => {
  const rewind = vi.fn().mockRejectedValueOnce(new Error('A turn is running')).mockResolvedValue(undefined)
  const onClose = vi.fn()
  Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: {
    rewindPoints: vi.fn().mockResolvedValue([
      { id: 'new', text: 'newest prompt', threadId: null, createdAt: 1000, laterMessages: 2, sessionTitle: 'Design pass' },
      { id: 'old', text: 'earlier prompt [@image](data:image/png;base64,ABCDEF', threadId: 'thread', laterMessages: 7 }
    ]), rewind
  } } })
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const key = async (value: string) => act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(
    new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  ))
  try {
    await act(async () => root.render(<RewindDialog sessionId="s" onClose={onClose} />))
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('newest prompt')
    expect(document.querySelector('.rewind-head')?.textContent).toBe('Rewind conversation')
    expect(document.querySelector('.rewind-footer')).toBeNull()
    expect(document.querySelector('.rewind-close')).toBeNull()
    expect(document.querySelector('[aria-selected="true"] .rewind-meta')?.textContent).toContain('2 messages later')
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('1970-01-01T00:00:01.000Z')
    await key('ArrowDown')
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('earlier prompt')
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('[Image]')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('base64')
    await key('Enter')
    expect(rewind).toHaveBeenCalledWith('s', 'old')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('A turn is running')
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('.rewind-preview')).toBeNull()
    await act(async () => (document.querySelector('[role="option"]') as HTMLElement).click())
    expect(rewind).toHaveBeenLastCalledWith('s', 'new')
    expect(onClose).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); el.remove() }
})


it('waits for cancellation to finish, then automatically rewinds the latest cancelled message once', async () => {
  const draft = { text: 'cancelled prompt', attachments: [] }
  const rewind = vi.fn().mockResolvedValue(draft)
  const rewindPoints = vi.fn().mockResolvedValue([
    { id: 'cancelled', text: draft.text, threadId: null, outcome: 'cancelled' },
    { id: 'older', text: 'older prompt', threadId: null }
  ])
  const onRewind = vi.fn()
  const onClose = vi.fn()
  Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: { rewindPoints, rewind } } })
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  try {
    await act(async () => root.render(<RewindDialog sessionId="s" running onRewind={onRewind} onClose={onClose} />))
    expect(rewindPoints).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(rewind).not.toHaveBeenCalled()
    await act(async () => root.render(<RewindDialog sessionId="s" running={false} onRewind={onRewind} onClose={onClose} />))
    expect(rewind).toHaveBeenCalledExactlyOnceWith('s', 'cancelled')
    expect(onRewind).toHaveBeenCalledWith(draft)
    expect(onClose).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); el.remove() }
})

it('keeps the picker available after automatic rewind fails, without retrying automatically', async () => {
  const rewind = vi.fn().mockRejectedValue(new Error('Cannot rewind yet'))
  Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: {
    rewindPoints: vi.fn().mockResolvedValue([{ id: 'm', text: 'cancelled prompt', threadId: null, outcome: 'cancelled' }]), rewind
  } } })
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const onClose = vi.fn()
  try {
    await act(async () => root.render(<RewindDialog sessionId="s" onClose={onClose} />))
    expect(rewind).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Cannot rewind yet')
    expect(document.querySelector('[role="option"]')?.textContent).toContain('cancelled prompt')
    expect(onClose).not.toHaveBeenCalled()
  } finally { act(() => root.unmount()); el.remove() }
})


it('shows no loading or rewinding popup during automatic rewind', async () => {
  let finish!: (draft: { text: string; attachments: [] }) => void
  const onClose = vi.fn()
  Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: {
    rewindPoints: vi.fn().mockResolvedValue([{ id: 'm', text: 'cancelled', outcome: 'cancelled' }]),
    rewind: vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve }))
  } } })
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  try {
    await act(async () => root.render(<RewindDialog sessionId="s" onClose={onClose} />))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Rewinding')
    await act(async () => { finish({ text: 'cancelled', attachments: [] }) })
    expect(onClose).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); el.remove() }
})
