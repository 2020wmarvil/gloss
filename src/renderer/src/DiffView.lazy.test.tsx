// @vitest-environment jsdom
// SPEC → Performance: a large review renders and colors only the expanded files near the
// view, and a diff read again with nothing changed renders nothing again.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { keepUnchanged, type DiffFile, type ReviewDiff } from '@shared/review'

const colored = vi.hoisted(() => ({ codes: [] as string[] }))
vi.mock('./highlight', () => ({
  useHighlighting: () => 0,
  cachedColors: () => undefined,
  codeColors: () => null,
  colorsInBackground: (code: string, _lang: string, done: (c: null) => void) => {
    colored.codes.push(code)
    done(null)
    return () => {}
  }
}))
import { DiffView, type Layout } from './DiffView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

/** IntersectionObserver as the test says: nothing is near until shown. */
const observers: { el: Element; callback: IntersectionObserverCallback }[] = []
class FakeObserver {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(el: Element): void {
    observers.push({ el, callback: this.callback })
  }
  disconnect(): void {
    for (let i = observers.length - 1; i >= 0; i--) if (observers[i].callback === this.callback) observers.splice(i, 1)
  }
}
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
  colored.codes = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  observers.length = 0
})

/** Brings what is observed inside `within` near the view. */
function show(within: Element): void {
  for (const o of [...observers]) {
    if (within.contains(o.el)) act(() => o.callback([{ isIntersecting: true, target: o.el } as unknown as IntersectionObserverEntry], o as unknown as IntersectionObserver))
  }
}

function file(i: number): DiffFile {
  const lines = Array.from({ length: 300 }, (_, k) => ({ kind: 'add' as const, old: null, new: k + 1, text: `file${i} line ${k}` }))
  return { path: `src/file${i}.ts`, status: 'added', binary: false, state: 'uncommitted', additions: 300, deletions: 0, hunks: [{ header: '@@ -0,0 +1,300 @@', lines }] }
}

it('renders and colors only expanded files near the view, and nothing again for an unchanged re-read', () => {
  const el = document.createElement('div')
  el.className = 'review-scroll'
  document.body.replaceChildren(el)
  const root = createRoot(el)
  let diff: ReviewDiff = { baseRef: 'main', base: 'a'.repeat(40), headRef: null, head: 'b'.repeat(40), files: Array.from({ length: 20 }, (_, i) => file(i)) }
  // Every file but the last is expanded.
  const expanded = new Set(diff.files.slice(0, -1).map((f) => f.path))
  const render = (layout: Layout = 'split'): void =>
    act(() =>
      root.render(
        <DiffView
          files={diff.files}
          layout={layout}
          cards={[]}
          active={null}
          showComments
          toggled={new Set()}
          expandedFiles={expanded}
          sources={{}}
          expansions={{}}
          onToggleFile={() => {}}
          onExpand={() => {}}
          onOpenFile={() => {}}
          onToggleCard={() => {}}
          onOpenThread={() => {}}
        />
      )
    )
  const section = (i: number): Element => el.querySelector(`.diff-file[data-file="src/file${i}.ts"]`)!
  try {
    render()
    // Nothing near yet: placeholders as tall as the rows will be, nothing colored.
    expect(el.querySelectorAll('.diff-row')).toHaveLength(0)
    expect(el.querySelectorAll('.diff-placeholder')).toHaveLength(19)
    expect((el.querySelector('.diff-placeholder') as HTMLElement).style.height).toBe(`${300 * 20 + 2 * 32}px`)
    expect(colored.codes).toHaveLength(0)

    // The first file comes near: its blocks of rows mount, then render as they come near too.
    show(section(0))
    expect(el.querySelectorAll('.diff-chunk')).toHaveLength(3)
    expect(el.querySelectorAll('.diff-row')).toHaveLength(0)
    show(section(0))
    expect(section(0).querySelectorAll('.diff-row')).toHaveLength(300)
    expect(el.querySelectorAll('.diff-row')).toHaveLength(300)
    // Colored: its two sides only.
    expect(colored.codes).toHaveLength(2)
    expect(colored.codes.every((c) => c === '' || c.startsWith('file0 '))).toBe(true)

    // A collapsed file is never watched, rendered or colored.
    show(section(19))
    expect(section(19).querySelector('.diff-row, .diff-placeholder')).toBeNull()
    expect(colored.codes).toHaveLength(2)

    // Read again with nothing changed: the same objects, nothing renders or colors again.
    const rows = section(0).querySelector('.diff-row')
    const again = keepUnchanged(diff, structuredClone(diff))
    expect(again).toBe(diff)
    render()
    expect(section(0).querySelector('.diff-row')).toBe(rows)
    expect(colored.codes).toHaveLength(2)

    // One file changed: only it is new.
    const next = structuredClone(diff)
    next.files[5].hunks[0].lines[0].text = 'changed'
    const kept = keepUnchanged(diff, next)
    expect(kept).not.toBe(diff)
    expect(kept.files.filter((f, i) => f !== diff.files[i]).map((f) => f.path)).toEqual(['src/file5.ts'])
    diff = kept
    render()
    expect(colored.codes).toHaveLength(2)

    // Without keeping them, every file shown would be colored again.
    diff = structuredClone(diff)
    render()
    expect(colored.codes).toHaveLength(4)
  } finally {
    act(() => root.unmount())
  }
})
