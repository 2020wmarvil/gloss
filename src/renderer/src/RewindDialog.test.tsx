// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { RewindDialog } from './RewindDialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('browses session messages by keyboard and confirms before rewinding', async () => {
  const rewind = vi.fn().mockRejectedValueOnce(new Error('A turn is running')).mockResolvedValue(undefined)
  const onClose = vi.fn()
  Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: {
    rewindPoints: vi.fn().mockResolvedValue([
      { id: 'new', text: 'newest prompt', threadId: null },
      { id: 'old', text: 'earlier prompt', threadId: 'thread' }
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
    await key('ArrowDown')
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toContain('earlier prompt')
    await key('Enter')
    expect(rewind).not.toHaveBeenCalled()
    expect(document.querySelector('.rewind-preview')?.textContent).toBe('earlier prompt')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Project files stay unchanged')
    await key('Escape')
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    await key('Enter')
    await key('Enter')
    expect(rewind).toHaveBeenCalledWith('s', 'old')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('A turn is running')
    expect(onClose).not.toHaveBeenCalled()
    await key('Enter')
    expect(onClose).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()); el.remove() }
})
