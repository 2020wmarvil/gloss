// @vitest-environment jsdom
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SlashCommand } from '@shared/types'
import { Composer } from './Composer'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null

function mount(
  draftKey: string,
  opts: {
    onSend?: (text: string) => void
    onSteer?: (text: string) => void
    commands?: SlashCommand[]
    running?: boolean
    onCancel?: () => void
    queued?: string[]
    history?: string[]
    accepts?: { image: boolean; file: boolean }
  } = {}
): EditorView {
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  act(() =>
    root!.render(
      <Composer
        draftKey={draftKey}
        className="composer"
        placeholder="Message the agent"
        running={opts.running ?? false}
        commands={opts.commands ?? []}
        accepts={opts.accepts ?? { image: false, file: false }}
        queue={{
          items: (opts.queued ?? []).map((text, i) => ({ id: `q${i}`, threadId: null, text, attachments: [] })),
          paused: false, onEdit: async () => {}, onRemove: async () => {}, onResume: async () => {} }}
        onSend={opts.onSend ?? (() => {})}
        onSteer={opts.onSteer}
        onCancel={opts.onCancel}
        history={opts.history}
      />
    )
  )
  return editor()
}

function editor(): EditorView {
  return EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
}

function unmount(): void {
  act(() => root?.unmount())
  root = null
}

/** Replaces the text the way typing does, with the caret at the end (or at "|"). */
function type(view: EditorView, value: string): void {
  const caret = value.includes('|') ? value.indexOf('|') : value.length
  const text = value.replace('|', '')
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: EditorSelection.cursor(caret), userEvent: 'input' })
  })
}

/** Presses a key in the editor; returns whether something handled it. */
function press(view: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
  let handled = false
  act(() => {
    handled = !view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  })
  return handled
}

const text = (view: EditorView): string => view.state.doc.toString()

afterEach(unmount)

describe('Composer drafts', () => {
  it('keeps unsent text per composer across switching away and back', () => {
    type(mount('s1'), 'half a thought')
    unmount()
    expect(text(mount('s2'))).toBe('')
    unmount()
    expect(text(mount('s1'))).toBe('half a thought')
  })

  it('puts the caret back where it was', () => {
    const view = mount('s4')
    type(view, 'hello world')
    act(() => view.dispatch({ selection: EditorSelection.single(2, 5) }))
    unmount()
    const main = mount('s4').state.selection.main
    expect([main.anchor, main.head]).toEqual([2, 5])
  })

  it('forgets the draft once it is cleared', () => {
    type(mount('s3'), 'draft')
    type(editor(), '')
    unmount()
    expect(text(mount('s3'))).toBe('')
  })
})

describe('Composer markdown editing', () => {
  it('sends on Enter exactly what was typed, and clears', () => {
    const onSend = vi.fn()
    const view = mount('m1', { onSend })
    type(view, '**Plan:**\n- one\n- two')
    press(view, 'Enter')
    expect(onSend).toHaveBeenCalledWith('**Plan:**\n- one\n- two', [])
    expect(text(view)).toBe('')
  })

  it('continues lists on Shift+Enter, renumbering ordered ones, and ends them on an empty item', () => {
    const view = mount('m2')
    type(view, '- one')
    press(view, 'Enter', { shiftKey: true })
    expect(text(view)).toBe('- one\n- ')
    press(view, 'Enter', { shiftKey: true })
    expect(text(view)).toBe('- one\n')
    type(view, '1. one')
    press(view, 'Enter', { shiftKey: true })
    expect(text(view)).toBe('1. one\n2. ')
    type(view, '- [ ] task')
    press(view, 'Enter', { shiftKey: true })
    expect(text(view)).toBe('- [ ] task\n- [ ] ')
    type(view, 'plain')
    press(view, 'Enter', { shiftKey: true })
    expect(text(view)).toBe('plain\n')
  })

  it('adds a line on Enter inside a code fence instead of sending', () => {
    const onSend = vi.fn()
    const view = mount('m3', { onSend })
    type(view, '```ts\nconst a = 1')
    press(view, 'Enter')
    expect(onSend).not.toHaveBeenCalled()
    expect(text(view)).toBe('```ts\nconst a = 1\n')
    type(view, '```\ncode\n```')
    press(view, 'Enter')
    expect(onSend).toHaveBeenCalledWith('```\ncode\n```', [])
  })

  it('formats the selection with Ctrl+B and indents list items with Tab', () => {
    const view = mount('m4')
    type(view, 'make this bold')
    act(() => view.dispatch({ selection: EditorSelection.single(10, 14) }))
    press(view, 'b', { ctrlKey: true })
    expect(text(view)).toBe('make this **bold**')
    type(view, '- one\n- two')
    expect(press(view, 'Tab')).toBe(true)
    expect(text(view)).toBe('- one\n  - two')
    expect(press(view, 'Tab', { shiftKey: true })).toBe(true)
    expect(text(view)).toBe('- one\n- two')
  })

  it('lets Tab complete a slash command and Enter send an exact one', () => {
    const onSend = vi.fn()
    const view = mount('m5', { onSend, commands: [{ name: 'compact', description: 'Compact' }] })
    type(view, '/com')
    expect(press(view, 'Tab')).toBe(true)
    expect(text(view)).toBe('/compact ')
    type(view, '/compact')
    press(view, 'Enter')
    expect(onSend).toHaveBeenCalledWith('/compact', [])
  })
})

describe('Composer history', () => {
  const history = ['/review XYZ', 'line one\nline two', 'oldest']

  it('recalls older messages with Up and comes back to the draft with Down', () => {
    const view = mount('h1', { history })
    type(view, 'my draft')
    expect(press(view, 'ArrowUp')).toBe(true)
    expect(text(view)).toBe('/review XYZ')
    // A recalled command doesn't open the slash menu.
    expect(document.querySelector('.slash-menu')).toBeNull()
    press(view, 'ArrowUp')
    expect(text(view)).toBe('line one\nline two')
    // The caret goes to the end, and Up keeps cycling from any line.
    expect(view.state.selection.main.head).toBe('line one\nline two'.length)
    press(view, 'ArrowUp')
    expect(text(view)).toBe('oldest')
    // The oldest: Up stays put.
    expect(press(view, 'ArrowUp')).toBe(true)
    expect(text(view)).toBe('oldest')
    press(view, 'ArrowDown')
    expect(text(view)).toBe('line one\nline two')
    press(view, 'ArrowDown')
    expect(text(view)).toBe('/review XYZ')
    press(view, 'ArrowDown')
    expect(text(view)).toBe('my draft')
    // Back on the draft, the arrows move the caret again.
    expect(press(view, 'ArrowDown')).toBe(false)
  })

  it('only starts from the first line, and stops cycling on an edit', () => {
    const onSend = vi.fn()
    const view = mount('h2', { history, onSend })
    type(view, 'a\nb')
    expect(press(view, 'ArrowUp')).toBe(false)
    type(view, '')
    press(view, 'ArrowUp')
    type(view, '/review ABC')
    expect(press(view, 'ArrowDown')).toBe(false)
    expect(text(view)).toBe('/review ABC')
    press(view, 'Enter')
    expect(onSend).toHaveBeenCalledWith('/review ABC', [])
  })

  it('stops cycling on Left or Right, even on one line or where the caret cannot move', () => {
    const view = mount('h4', { history })
    press(view, 'ArrowUp')
    expect(text(view)).toBe('/review XYZ')
    // The caret is already at the end: Right moves nothing, but still means "edit this one".
    press(view, 'ArrowRight')
    expect(press(view, 'ArrowUp')).toBe(false)
    expect(press(view, 'ArrowDown')).toBe(false)
    expect(text(view)).toBe('/review XYZ')
    // Until the composer is cleared.
    type(view, '')
    press(view, 'ArrowUp')
    expect(text(view)).toBe('/review XYZ')
    press(view, 'ArrowLeft')
    expect(press(view, 'ArrowUp')).toBe(false)
    expect(text(view)).toBe('/review XYZ')
  })

  it('stops cycling when the caret is moved, so Up and Down move between lines', () => {
    const view = mount('h3', { history })
    press(view, 'ArrowUp')
    press(view, 'ArrowUp')
    expect(text(view)).toBe('line one\nline two')
    // A click (or Left, Home…) moves the caret: the arrows are the editor's again.
    act(() => view.dispatch({ selection: EditorSelection.cursor('line one\nli'.length) }))
    expect(press(view, 'ArrowDown')).toBe(false)
    expect(press(view, 'ArrowUp')).toBe(false)
    expect(text(view)).toBe('line one\nline two')
  })
})

describe('Composer cancel', () => {
  it('offers Cancel and Escape only in the composer of the working thread', () => {
    const onCancel = vi.fn()
    const view = mount('s1', { running: true, onCancel, commands: [{ name: 'compact', description: 'Compact' }] })
    expect(document.querySelector('.cancel')).not.toBeNull()
    // Escape closes the slash commands first.
    type(view, '/co')
    press(view, 'Escape')
    expect(onCancel).not.toHaveBeenCalled()
    press(view, 'Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
    act(() => (document.querySelector('.cancel') as HTMLButtonElement).click())
    expect(onCancel).toHaveBeenCalledTimes(2)
    unmount()

    const elsewhere = mount('s2', { running: true })
    expect(document.querySelector('.cancel')).toBeNull()
    expect(document.querySelector('.send')!.textContent).toBe('Queue')
    expect(press(elsewhere, 'Escape')).toBe(false)
  })

  it("doesn't cancel on Escape when idle", () => {
    const onCancel = vi.fn()
    const view = mount('s3', { onCancel })
    expect(document.querySelector('.cancel')).toBeNull()
    press(view, 'Escape')
    expect(onCancel).not.toHaveBeenCalled()
  })
})

describe('Composer queue', () => {
  it('lists the next message to run at the bottom, by the composer', () => {
    mount('s4', { running: true, queued: ['first', 'second'] })
    expect([...document.querySelectorAll('.queued-text')].map((t) => t.lastChild!.textContent)).toEqual(['second', 'first'])
  })
})


describe('automatic steering', () => {
  it.each(['Enter', 'button', 'Ctrl+Enter'])('steers the active thread using %s', (how) => {
    const onSend = vi.fn()
    const onSteer = vi.fn()
    const view = mount(`auto-${how}`, { running: true, onSend, onSteer })
    type(view, 'use the helper')
    expect(document.querySelector('.send')!.textContent).toBe('Steer')
    expect(document.querySelector('button.steer')).toBeNull()
    if (how === 'button') act(() => document.querySelector<HTMLButtonElement>('.send')!.click())
    else press(view, 'Enter', { ctrlKey: how === 'Ctrl+Enter' })
    expect(onSteer).toHaveBeenCalledWith('use the helper', [])
    expect(onSend).not.toHaveBeenCalled()
    expect(text(view)).toBe('')
  })

  it('has no way to queue instead of steering', () => {
    const onSend = vi.fn()
    const onSteer = vi.fn()
    const view = mount('alt-enter', { running: true, onSend, onSteer })
    type(view, 'into this turn')
    press(view, 'Enter', { altKey: true })
    expect(onSend).not.toHaveBeenCalled()
    expect(document.querySelector('.composer-mode')).toBeNull()
  })

  it('queues when this composer cannot steer the active turn', () => {
    const onSend = vi.fn()
    const view = mount('other-thread', { running: true, onSend })
    type(view, 'another task')
    expect(document.querySelector('.send')!.textContent).toBe('Queue')
    press(view, 'Enter')
    expect(onSend).toHaveBeenCalledWith('another task', [])
  })
})

describe('screen capture', () => {
  afterEach(unmount)

  /** The Attach menu's Capture item, after opening the menu. */
  function captureItem(): HTMLButtonElement {
    act(() => document.querySelector<HTMLButtonElement>('button[title="Attach"]')!.click())
    return [...document.querySelectorAll<HTMLButtonElement>('.attach-menu button')].find((b) => b.textContent?.includes('Capture'))!
  }

  it('is in the Attach menu, off and saying why when the agent takes no images', () => {
    mount('capture-off', { accepts: { image: false, file: true } })
    const item = captureItem()
    expect(item.disabled).toBe(true)
    expect(item.textContent).toMatch(/doesn't accept images/)
    unmount()
    mount('capture-none')
    expect(document.querySelector('button[title="Attach"]')).toBeNull()
  })

  it('opens the annotation canvas on the capture, and the capture shortcut goes to the composer used last', async () => {
    // jsdom has neither layout nor canvas: the dialog still opens, without drawing.
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    const start = vi.fn(async () => ({ data: 'iVBOR', width: 40, height: 30, source: 'Region' }))
    window.gloss = { capture: { start } } as unknown as typeof window.gloss
    const view = mount('capture-on', { accepts: { image: true, file: false } })
    const item = captureItem()
    await act(async () => {
      item.click()
    })
    expect(start).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe('Annotate')
    expect(document.querySelector('.annotate-head .muted')?.textContent).toBe('Region · 40 × 30')
    expect(document.querySelector('.annotate-text pre')?.textContent).toBe('Just the screenshot, without pins.')
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.annotate-foot button.ghost')!.click()
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    act(() => view.focus())
    await act(async () => {
      window.dispatchEvent(new Event('gloss:capture'))
    })
    expect(start).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })
})
