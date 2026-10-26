// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { expect, it, vi } from 'vitest'
import { useRightButtonLines } from './lineSelect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([false, true])('keeps a right-click selection on window activation (existing selection: %s)', async (existing) => {
  const host = document.createElement('div')
  const composer = document.createElement('div')
  document.body.replaceChildren(host, composer)
  const root = createRoot(host)
  const onMenu = vi.fn()
  const view = new EditorView({ parent: composer, state: EditorState.create({ doc: 'Draft to keep' }) })
  function Log(): React.JSX.Element {
    const scope = useRef<HTMLDivElement>(null)
    useRightButtonLines({ scope, onMenu, lineAt: () => {
      const el = scope.current!.firstElementChild as HTMLElement
      const node = el.firstChild!
      return { el, start: { node, offset: 0 }, end: { node, offset: node.textContent!.length } }
    } })
    return <div ref={scope}><p>Selected line</p></div>
  }
  const focused = vi.spyOn(document, 'hasFocus')
  const rects = vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue(
    Object.assign([new DOMRect(0, 0, 200, 20)], { item: () => null }) as unknown as DOMRectList
  )
  try {
    await act(async () => root.render(<Log />))
    view.focus()
    expect(document.activeElement).toBe(view.contentDOM)
    // An inactive window retains its active element, which gets a focus event
    // when a right-click brings the window forward.
    focused.mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    if (existing) {
      const node = host.querySelector('p')!.firstChild!
      window.getSelection()!.setBaseAndExtent(node, 2, node, 8)
    }
    focused.mockReturnValue(true)
    await act(async () => {
      view.contentDOM.dispatchEvent(new FocusEvent('focus'))
      host.querySelector('p')!.dispatchEvent(new MouseEvent('mousedown', { button: 2, clientX: 10, clientY: 10, bubbles: true, cancelable: true }))
      document.dispatchEvent(new MouseEvent('mouseup', { button: 2, clientX: 10, clientY: 10, bubbles: true }))
      // Let CodeMirror's deferred focus update run.
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(document.activeElement).not.toBe(view.contentDOM)
    expect(window.getSelection()!.toString()).toBe(existing ? 'lected' : 'Selected line')
    expect(onMenu).toHaveBeenCalledOnce()
    expect(view.state.doc.toString()).toBe('Draft to keep')
  } finally {
    act(() => root.unmount())
    view.destroy()
    focused.mockRestore()
    rects.mockRestore()
    window.getSelection()?.removeAllRanges()
  }
})
