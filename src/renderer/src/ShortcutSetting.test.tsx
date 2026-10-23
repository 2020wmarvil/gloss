// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ShortcutSetting } from './ShortcutSetting'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let pause: ReturnType<typeof vi.fn<(paused: boolean) => Promise<void>>>
let onChange: ReturnType<typeof vi.fn<(value: string) => void>>

beforeEach(() => {
  pause = vi.fn(async () => {})
  onChange = vi.fn()
  window.gloss = {
    capture: { pauseShortcut: pause, shortcutStatus: async () => ({ shortcut: null, error: null }) }
  } as unknown as typeof window.gloss
})

afterEach(() => act(() => root.unmount()))

async function mount(value: string): Promise<HTMLButtonElement> {
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root.render(<ShortcutSetting id="s" value={value} onChange={onChange} />))
  return document.getElementById('s') as HTMLButtonElement
}

function key(box: HTMLElement, type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}): void {
  act(() => {
    box.dispatchEvent(new KeyboardEvent(type, { code, key: init.key ?? code, bubbles: true, ...init }))
  })
}

it('records a pressed combination, pausing the current shortcut meanwhile', async () => {
  const box = await mount('Ctrl+Shift+PrintScreen')
  expect([...box.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'Shift', 'PrtSc'])
  act(() => box.click())
  expect(pause).toHaveBeenLastCalledWith(true)
  expect(box.textContent).toBe('Press keys…')
  key(box, 'keydown', 'ControlLeft', { ctrlKey: true })
  key(box, 'keydown', 'AltLeft', { ctrlKey: true, altKey: true })
  expect([...box.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'Alt'])
  key(box, 'keydown', 'KeyS', { ctrlKey: true, altKey: true, shiftKey: true, key: 'S' })
  expect(onChange).toHaveBeenCalledWith('Ctrl+Alt+Shift+S')
  expect(pause).toHaveBeenLastCalledWith(false)
})

it('explains a key that would stop typing, and Esc cancels', async () => {
  const box = await mount('Ctrl+Alt+Shift+S')
  act(() => box.click())
  key(box, 'keydown', 'KeyS', { key: 's' })
  expect(document.querySelector('.shortcut-note')?.textContent).toBe('Add Ctrl, Alt or Win.')
  key(box, 'keydown', 'Escape', { key: 'Escape' })
  expect(onChange).not.toHaveBeenCalled()
  expect(pause).toHaveBeenLastCalledWith(false)
  expect([...box.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'Alt', 'Shift', 'S'])
})

it('takes PrintScreen from its keyup, which is all Windows sends', async () => {
  const box = await mount('')
  expect(box.textContent).toBe('None')
  act(() => box.click())
  key(box, 'keyup', 'PrintScreen', { ctrlKey: true, key: 'PrintScreen' })
  expect(onChange).toHaveBeenCalledWith('Ctrl+PrintScreen')
})

it('clears with Backspace while recording, and has no other buttons', async () => {
  const box = await mount('Ctrl+Alt+Shift+S')
  expect(document.querySelectorAll('.shortcut-setting button')).toHaveLength(1)
  act(() => box.click())
  key(box, 'keydown', 'Backspace', { key: 'Backspace' })
  expect(onChange).toHaveBeenLastCalledWith('')
  expect(pause).toHaveBeenLastCalledWith(false)
})
