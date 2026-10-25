// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AnnotateDialog } from './AnnotateDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  act(() => root.render(<AnnotateDialog
    initial={{ capture: { data: '', width: 100, height: 100, source: 'Test' }, shapes: [], pins: [] }}
    onAdd={() => {}} onCancel={() => {}}
  />))
})
afterEach(() => {
  act(() => root.unmount())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function button(name: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
}

function placePin(): HTMLTextAreaElement {
  act(() => button('Pin').click())
  const canvas = document.querySelector('canvas')!
  canvas.setPointerCapture = vi.fn()
  act(() => canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 2, clientY: 2 })))
  return document.querySelector('textarea')!
}

function undo(target: HTMLElement, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true, ...init })
  act(() => target.dispatchEvent(event))
  return event
}

it('starts with pencil selected and lists pin after the drawing tools', () => {
  const names = [...document.querySelectorAll('.annotate-tools button')].map((b) => b.getAttribute('aria-label'))
  expect(names.slice(0, 5)).toEqual(['Pen', 'Highlighter', 'Box', 'Arrow', 'Pin'])
  expect(button('Pen').getAttribute('aria-pressed')).toBe('true')
})

it('undoes an accidental pin from its empty note and allows redo', () => {
  const note = placePin()
  expect(note.value).toBe('')
  expect(undo(note).defaultPrevented).toBe(true)
  expect(document.querySelector('textarea')).toBeNull()
  act(() => button('Redo').click())
  expect(document.querySelector('textarea')).not.toBeNull()
})

it('preserves native text undo and redo for note editing', () => {
  const note = placePin()
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setter.call(note, 'Keep this pin')
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(undo(note).defaultPrevented).toBe(false)
  expect(document.querySelector('textarea')).toBe(note)
  act(() => {
    setter.call(note, '')
    note.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(undo(note, { shiftKey: true }).defaultPrevented).toBe(false)
  expect(undo(note, { ctrlKey: false, metaKey: true }).defaultPrevented).toBe(true)
  expect(document.querySelector('textarea')).toBeNull()
})
