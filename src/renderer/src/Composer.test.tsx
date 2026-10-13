// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer } from './Composer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

function mount(draftKey: string): HTMLTextAreaElement {
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
        onSend={() => {}}
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
