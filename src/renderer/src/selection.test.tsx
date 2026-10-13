// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { Markdown, type MessageAnchors } from './Markdown'
import { rangeToSource } from './selection'
import { renderedText } from './source'
import type { Mark } from './sourceSpans'

const MD = [
  'One concern: **backoff resets** on every',
  'reconnect, so `retry()` never backs off &amp; spins.',
  '',
  '1. First item',
  '2. Second',
  '',
  '```js',
  'code line',
  '```',
  ''
].join('\n')

function anchors(marks: Mark[] = []): MessageAnchors {
  return {
    replyCount: () => 0,
    activeIndex: null,
    runningIndex: null,
    onOpenItem: () => {},
    marks,
    threadCount: () => 3,
    runningThread: null,
    onOpenThread: () => {}
  }
}

let root: HTMLElement

function render(marks: Mark[] = []): void {
  document.body.innerHTML = renderToStaticMarkup(<Markdown text={MD} anchors={anchors(marks)} />)
  root = document.body.firstElementChild as HTMLElement
}

/** The DOM point at a character index of root.textContent. */
function point(index: number): [Node, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let seen = 0
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.textContent!.length
    if (index <= seen + len) return [n, index - seen]
    seen += len
  }
  throw new Error('index out of range')
}

/** A range over rendered text from the start of `from` to the end of `to`. */
function select(from: string, to: string, fromNth = 0): Range {
  const text = root.textContent!
  let s = -1
  for (let k = 0; k <= fromNth; k++) s = text.indexOf(from, s + 1)
  const e = text.indexOf(to, s) + to.length
  if (s === -1 || e < to.length) throw new Error(`not rendered: ${from} … ${to}`)
  const range = document.createRange()
  range.setStart(...point(s))
  range.setEnd(...point(e))
  return range
}

function mapped(range: Range): { slice: string; text: string } {
  const r = rangeToSource(root, range, MD)
  if (!r) throw new Error('no mapping')
  return { slice: MD.slice(r.start, r.end), text: renderedText(MD, r.start, r.end) }
}

describe('rangeToSource', () => {
  beforeEach(() => render())

  it('maps a selection across bold text and a soft line break', () => {
    expect(mapped(select('backoff', 'reconnect'))).toEqual({
      slice: 'backoff resets** on every\nreconnect',
      text: 'backoff resets on every reconnect'
    })
  })

  it('maps part of an inline code span and decoded entities', () => {
    expect(mapped(select('retry', 'retry')).slice).toBe('retry')
    expect(mapped(select('off &', 'spins')).slice).toBe('off &amp; spins')
  })

  it('maps across list items, ignoring markers and buttons', () => {
    expect(mapped(select('item', 'Sec'))).toEqual({ slice: 'item\n2. Sec', text: 'item Sec' })
  })

  it('maps inside a fenced code block', () => {
    expect(mapped(select('code', 'line')).slice).toBe('code line')
  })

  it('snaps a boundary inside UI text to the nearest message text', () => {
    // "Reply" is the first item's button label, after "First item".
    expect(mapped(select('Reply', 'Second')).slice).toBe('Second')
  })

  it('returns null for a selection with no message text', () => {
    expect(rangeToSource(root, select('Reply', 'Reply'), MD)).toBeNull()
  })
})

describe('marks', () => {
  it('underlines anchored text, adds a chip, and keeps the text and its mapping intact', () => {
    const start = MD.indexOf('every')
    const end = MD.indexOf(', so')
    render([{ start, end, threadId: 't1' }])

    const anchored = Array.from(root.querySelectorAll('.anchored'))
    expect(anchored.every((a) => a.getAttribute('data-thread') === 't1')).toBe(true)
    expect(anchored.map((a) => a.textContent).join('')).toBe('every\nreconnect')
    const chip = root.querySelector('button.anchor-chip')!
    expect(chip.textContent).toBe('3')
    expect(chip.previousElementSibling?.textContent).toBe('every\nreconnect')

    expect(mapped(select('on every', 'reconnect')).slice).toBe('on every\nreconnect')
  })

  it('puts chips after inline code and below code blocks, not inside them', () => {
    const inline = MD.indexOf('retry()')
    const block = MD.indexOf('code line')
    render([
      { start: inline, end: inline + 5, threadId: 'inline', title: 'retry' },
      { start: block, end: block + 4, threadId: 'block', title: 'code' }
    ])
    const inlineChip = root.querySelector('[aria-label^="Open thread"]')!
    expect(inlineChip.closest('code')).toBeNull()
    expect(inlineChip.parentElement?.previousElementSibling?.tagName).toBe('CODE')
    expect(inlineChip.getAttribute('title')).toBe('“retry”')

    const chips = root.querySelectorAll('button.anchor-chip')
    const blockChip = chips[chips.length - 1]
    expect(blockChip.closest('pre')).toBeNull()
    expect(blockChip.parentElement?.className).toBe('anchor-chips')
    expect(blockChip.parentElement?.previousElementSibling?.classList.contains('code-block')).toBe(true)

    // The marks themselves stay inside the code.
    expect(root.querySelector('code .anchored[data-thread="inline"]')?.textContent).toBe('retry')
    expect(root.querySelector('pre .anchored[data-thread="block"]')?.textContent).toBe('code')
    // Chips are not message text, so selections still map cleanly.
    expect(mapped(select('so', 'never')).slice).toBe('so `retry()` never')
  })

  it('highlights a draft anchor without a chip', () => {
    const start = MD.indexOf('First')
    render([{ start, end: start + 5, threadId: null }])
    expect(root.querySelector('.anchored.pending')?.textContent).toBe('First')
    expect(root.querySelector('.anchor-chip')).toBeNull()
  })
})
