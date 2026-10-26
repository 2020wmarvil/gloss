// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Markdown, type MessageAnchors } from './Markdown'

const parsed = vi.hoisted(() => vi.fn())
vi.mock('./highlight', () => ({ useHighlighting: () => 0, codeColors: () => null }))
vi.mock('react-markdown', async (original) => {
  const actual = await original<typeof import('react-markdown')>()
  return { ...actual, default: (props: Parameters<typeof actual.default>[0]) => {
    parsed(props.children)
    return <actual.default {...props} />
  } }
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => parsed.mockClear())

it('reuses unchanged annotated content, refreshes callbacks, and invalidates visible counts, marks and text', () => {
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  const root = createRoot(el)
  const oldAction = vi.fn()
  const nextAction = vi.fn()
  const anchors = (onOpenItem = oldAction, count = 0): MessageAnchors => ({
    replyCount: () => count, activeIndex: null, runningIndex: null,
    onOpenItem, marks: [], threadCount: () => 0, runningThread: null, onOpenThread: vi.fn()
  })
  const render = (a: MessageAnchors, text = '1. First\n2. Second') => act(() => root.render(<Markdown text={text} anchors={a} />))
  try {
    render(anchors())
    const firstSpan = el.querySelector('[data-src]')
    expect(parsed).toHaveBeenCalledTimes(1)
    render(anchors(nextAction))
    expect(parsed).toHaveBeenCalledTimes(1)
    expect(el.querySelector('[data-src]')).toBe(firstSpan)
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="Reply to item 1"]')!.click())
    expect(oldAction).not.toHaveBeenCalled()
    expect(nextAction).toHaveBeenCalledOnce()
    render(anchors(nextAction, 2))
    expect(parsed).toHaveBeenCalledTimes(2)
    expect(el.querySelector('.item-count')!.textContent).toContain('2')
    render({ ...anchors(), marks: [{ start: 3, end: 8, threadId: 't', className: 'active' }], threadCount: () => 3 })
    expect(parsed).toHaveBeenCalledTimes(3)
    expect(el.querySelector('.anchored.active')).not.toBeNull()
    render(anchors(), '1. First\n2. Second, now streaming')
    expect(parsed).toHaveBeenCalledTimes(4)
    expect(el.textContent).toContain('now streaming')
  } finally { act(() => root.unmount()) }
})
