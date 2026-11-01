// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { Message } from '@shared/types'
import { SelectionMenu } from './SelectionMenu'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([
  { backwards: false, acrossMessages: true }, { backwards: true, acrossMessages: true },
  { backwards: false, acrossMessages: false }, { backwards: true, acrossMessages: false }
])('right-drags across blocks (backwards: $backwards, across messages: $acrossMessages)', async ({ backwards, acrossMessages }) => {
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  window.getSelection()?.removeAllRanges()
  const root = createRoot(host)
  const onReply = vi.fn()
  const messages: Message[] = (acrossMessages ? ['First block', 'Second block'] : ['First block\n\nSecond block']).map((text, seq) => ({
    id: String(seq), sessionId: 'session', threadId: null, role: 'agent', seq, text
  }))
  function Log(): React.JSX.Element {
    const scope = useRef<HTMLDivElement>(null)
    return <><div ref={scope}>{messages.map((m) => <div key={m.id} data-message-id={m.id}>
      {m.text.split('\n\n').map((text) => <p key={text}><span data-src={m.text.indexOf(text)} data-src-end={m.text.indexOf(text) + text.length}>{text}</span></p>)}
    </div>)}</div>
      <SelectionMenu scope={scope} messages={messages} onReply={onReply} /></>
  }
  const caret = vi.fn((_x: number, y: number) => {
    const range = document.createRange()
    range.setStart(host.querySelectorAll('p')[y < 50 ? 0 : 1].firstChild!.firstChild!, 3)
    range.collapse(true)
    return range
  })
  const selection = window.getSelection()!
  const oldCaret = document.caretRangeFromPoint
  const oldModify = selection.modify
  document.caretRangeFromPoint = caret
  selection.modify = (_alter, direction) => {
    const node = selection.focusNode!
    selection.collapse(node, direction === 'backward' ? 0 : node.textContent!.length)
  }
  try {
    await act(async () => root.render(<Log />))
    const paragraphs = host.querySelectorAll('p')
    await act(async () => {
      paragraphs[backwards ? 1 : 0].dispatchEvent(new MouseEvent('mousedown', {
        button: 2, clientX: 10, clientY: backwards ? 70 : 10, bubbles: true, cancelable: true
      }))
      paragraphs[backwards ? 0 : 1].dispatchEvent(new MouseEvent('mousemove', {
        buttons: 2, clientX: 10, clientY: backwards ? 10 : 70, bubbles: true
      }))
      document.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true }))
    })
    expect(selection.toString()).toBe('First blockSecond block')
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.parentElement).toBe(document.body)
    const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    expect([...items].map((b) => b.textContent)).toEqual(['Reply to selection', 'Reply - Fork', 'Copy'])
    expect(items[0].getAttribute('aria-disabled')).toBe(acrossMessages ? 'true' : null)
    expect(items[0].title).toBe(acrossMessages ? 'Replying requires text from a single agent message.' : '')
    // Reply - Fork needs one message too; Copy doesn't.
    expect(items[1].getAttribute('aria-disabled')).toBe(acrossMessages ? 'true' : null)
    expect(items[2].getAttribute('aria-disabled')).toBeNull()
    if (acrossMessages) {
      await act(async () => items[0].click())
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' })))
      expect(onReply).not.toHaveBeenCalled()
      expect(document.querySelector('[role="menu"]')).not.toBeNull()
      expect(selection.toString()).toBe('First blockSecond block')
    }
    // Dismissing the menu keeps the highlight available for copying.
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(selection.toString()).toBe('First blockSecond block')
  } finally {
    act(() => root.unmount())
    document.caretRangeFromPoint = oldCaret
    selection.modify = oldModify
    selection.removeAllRanges()
  }
})

it.each([{ forkDisabled: undefined }, { forkDisabled: "Fake Agent can't fork sessions." }])(
  'replies in a fork with F unless the agent cannot fork ($forkDisabled)',
  async ({ forkDisabled }) => {
    const host = document.createElement('div')
    document.body.replaceChildren(host)
    const root = createRoot(host)
    const onReply = vi.fn()
    const message: Message = { id: 'm', sessionId: 'session', threadId: null, role: 'agent', seq: 0, text: 'Fork this point' }
    function Log(): React.JSX.Element {
      const scope = useRef<HTMLDivElement>(null)
      return <><div ref={scope}><div data-message-id="m"><p><span data-src={0} data-src-end={15}>Fork this point</span></p></div></div>
        <SelectionMenu scope={scope} messages={[message]} onReply={onReply} forkDisabled={forkDisabled} /></>
    }
    try {
      await act(async () => root.render(<Log />))
      const text = host.querySelector('span')!.firstChild!
      window.getSelection()!.setBaseAndExtent(text, 0, text, 4)
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' })))
      if (forkDisabled) expect(onReply).not.toHaveBeenCalled()
      else expect(onReply).toHaveBeenCalledWith(message, { start: 0, end: 4, text: 'Fork' }, true)
      window.getSelection()!.setBaseAndExtent(text, 0, text, 4)
      await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' })))
      expect(onReply).toHaveBeenLastCalledWith(message, { start: 0, end: 4, text: 'Fork' }, false)
    } finally {
      act(() => root.unmount())
      window.getSelection()?.removeAllRanges()
    }
  }
)
