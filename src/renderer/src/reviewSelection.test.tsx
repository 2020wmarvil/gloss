// @vitest-environment jsdom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useReviewFileSelection } from './reviewSelection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each([false, true])('clamps left-drag to its starting review file (backwards: %s)', async (backwards) => {
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  const root = createRoot(host)
  function Diff(): React.JSX.Element {
    const scope = useRef<HTMLDivElement>(null)
    useReviewFileSelection(scope)
    return <div ref={scope}>{['first', 'second'].map((file) => <section key={file} className="diff-file">
      <div className="diff-body"><div className="code" data-line="1"><span className="w">{file} file</span></div></div>
    </section>)}</div>
  }
  const selection = window.getSelection()!
  try {
    await act(async () => root.render(<Diff />))
    const text = host.querySelectorAll('.w')
    const start = text[backwards ? 1 : 0]
    const other = text[backwards ? 0 : 1]
    start.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    expect(host.querySelector('.review-file-selecting')).not.toBeNull()
    expect(start.closest('.diff-file')?.classList.contains('review-selection-origin')).toBe(true)
    expect(other.closest('.diff-file')?.classList.contains('review-selection-origin')).toBe(false)
    selection.setBaseAndExtent(start.firstChild!, 3, other.firstChild!, 4)
    document.dispatchEvent(new Event('selectionchange'))
    expect(selection.anchorNode).toBe(start.firstChild)
    expect(selection.anchorOffset).toBe(3)
    expect(start.contains(selection.focusNode)).toBe(true)
    expect(selection.toString()).toBe(backwards ? 'sec' : 'st file')
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }))
    expect(host.querySelector('.review-file-selecting')).toBeNull()
    expect(host.querySelector('.review-selection-origin')).toBeNull()
    // A fresh drag can select the other file normally.
    other.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
    selection.setBaseAndExtent(other.firstChild!, 0, other.firstChild!, 5)
    document.dispatchEvent(new Event('selectionchange'))
    expect(selection.toString()).toBe(backwards ? 'first' : 'secon')
  } finally {
    act(() => root.unmount())
    selection.removeAllRanges()
  }
})
