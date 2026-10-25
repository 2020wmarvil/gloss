// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlossEvent } from '@shared/ipc'
import { CloseDialog } from './CloseDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let emit: (event: GlossEvent) => void
let previous: HTMLButtonElement
const confirm = vi.fn<(id: string, approved: boolean) => Promise<void>>(async () => {})
const unsubscribe = vi.fn()

beforeEach(() => {
  confirm.mockClear()
  unsubscribe.mockClear()
  Object.defineProperty(window, 'gloss', { configurable: true, value: {
    onEvent: (listener: typeof emit) => { emit = listener; return unsubscribe },
    confirmClose: confirm
  } })
  const host = document.createElement('div')
  previous = document.createElement('button')
  document.body.replaceChildren(host, previous)
  previous.focus()
  root = createRoot(host)
  act(() => root.render(<CloseDialog />))
})
afterEach(() => { act(() => root.unmount()) })

function show(working = 1): void {
  act(() => emit({ type: 'confirmClose', requestId: 'request', working }))
}
async function key(key: string, shiftKey = false): Promise<void> {
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })) })
}

it('focuses Keep open, traps Tab, and dismisses with Escape without closing', async () => {
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  show(2)
  expect(document.querySelector('#close-description')!.textContent).toContain('2 sessions are still working.')
  expect(document.activeElement?.textContent).toBe('Keep open')
  await key('Tab', true)
  expect(document.activeElement?.textContent).toBe('Close Gloss')
  await key('Tab')
  expect(document.activeElement?.textContent).toBe('Keep open')
  await key('Escape')
  expect(confirm).toHaveBeenCalledExactlyOnceWith('request', false)
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(document.activeElement).toBe(previous)
})

it('requires clicking Close Gloss to approve shutdown', async () => {
  show()
  expect(document.querySelector('#close-description')!.textContent).toContain('A session is still working.')
  await act(async () => document.querySelector<HTMLButtonElement>('.close-dialog .danger')!.click())
  expect(confirm).toHaveBeenCalledExactlyOnceWith('request', true)
})

it('treats a backdrop click as Keep open and keeps app shortcuts out', async () => {
  show()
  const shortcut = vi.fn()
  window.addEventListener('keydown', shortcut)
  try {
    await key('n')
    expect(shortcut).not.toHaveBeenCalled()
    await act(async () => document.querySelector<HTMLElement>('.close-backdrop')!.click())
    expect(confirm).toHaveBeenCalledExactlyOnceWith('request', false)
  } finally { window.removeEventListener('keydown', shortcut) }
})

it('keeps the dialog available if sending an answer fails', async () => {
  confirm.mockRejectedValueOnce(new Error('IPC unavailable'))
  show()
  await key('Escape')
  expect(document.querySelector('[role="alert"]')!.textContent).toContain('Please try again')
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull()
  await key('Escape')
  expect(confirm).toHaveBeenCalledTimes(2)
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
})
