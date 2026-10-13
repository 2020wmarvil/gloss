// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

function mount(draftKey: string, onSend: (text: string) => void = () => {}): HTMLTextAreaElement {
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  act(() =>
    root!.render(
      <Composer
        draftKey={draftKey}
        className="composer"
        placeholder="Message the agent"
        running={false}
        commands={[]}
        accepts={{ image: false, file: false }}
        queue={{ items: [], paused: false, onEdit: async () => {}, onRemove: async () => {}, onResume: async () => {} }}
        onSend={onSend}
        onCancel={() => {}}
      />
    )
  )
  return el.querySelector('textarea')!
}

function unmount(): void {
  act(() => root?.unmount())
  root = null
}

/** Types into a controlled textarea the way React sees it. */
function type(textarea: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Presses a key with the caret at the end; returns whether the composer handled it itself. */
function press(textarea: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}): boolean {
  let handled = false
  act(() => {
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    handled = !textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
  return handled
}

afterEach(unmount)

describe('Composer drafts', () => {
  it('keeps unsent text per composer across switching away and back', () => {
    type(mount('s1'), 'half a thought')
    unmount()
    expect(mount('s2').value).toBe('')
    unmount()
    expect(mount('s1').value).toBe('half a thought')
  })

  it('puts the caret back where it was', () => {
    const textarea = mount('s4')
    type(textarea, 'hello world')
    act(() => textarea.setSelectionRange(2, 5))
    unmount()
    const again = mount('s4')
    expect([again.selectionStart, again.selectionEnd]).toEqual([2, 5])
  })

  it('forgets the draft once it is cleared', () => {
    type(mount('s3'), 'draft')
    type(document.querySelector('textarea')!, '')
    unmount()
    expect(mount('s3').value).toBe('')
  })
})

describe('Composer bullets', () => {
  it('turns "* " into a bullet, continues the list and sends it as markdown', () => {
    const onSend = vi.fn()
    const textarea = mount('b1', onSend)
    type(textarea, 'Plan:\n*')
    expect(press(textarea, ' ')).toBe(true)
    expect(textarea.value).toBe('Plan:\n• ')
    type(textarea, 'Plan:\n• one')
    expect(press(textarea, 'Enter', { shiftKey: true })).toBe(true)
    expect(textarea.value).toBe('Plan:\n• one\n• ')
    expect(textarea.selectionStart).toBe(textarea.value.length)
    type(textarea, 'Plan:\n• one\n• two')
    press(textarea, 'Enter')
    expect(onSend).toHaveBeenCalledWith('Plan:\n- one\n- two', [])
  })

  it('ends the list on Shift+Enter at an empty bullet, and Backspace removes a bullet', () => {
    const textarea = mount('b2')
    type(textarea, '• one\n• ')
    press(textarea, 'Enter', { shiftKey: true })
    expect(textarea.value).toBe('• one\n')
    type(textarea, '• ')
    expect(press(textarea, 'Backspace')).toBe(true)
    expect(textarea.value).toBe('')
  })

  it("leaves a \"*\" that isn't at the start of a line alone", () => {
    const textarea = mount('b3')
    type(textarea, 'a *')
    expect(press(textarea, ' ')).toBe(false)
  })
})
