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
    primary?: boolean
    onInterrupt?: () => void
    sessionId?: string
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
        primary={opts.primary}
        onInterrupt={opts.onInterrupt}
        sessionId={opts.sessionId}
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

  it('recalls older messages with Up and comes back to the empty composer with Down', () => {
    const view = mount('h1', { history })
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
    expect(text(view)).toBe('')
    // Back on the empty composer, Down does nothing.
    expect(press(view, 'ArrowDown')).toBe(false)
  })

  it('only starts in an empty composer, and stops cycling on an edit', () => {
    const onSend = vi.fn()
    const view = mount('h2', { history, onSend })
    // Even with the caret at the start of a one-line draft.
    type(view, 'draft')
    act(() => view.dispatch({ selection: EditorSelection.cursor(0) }))
    expect(press(view, 'ArrowUp')).toBe(false)
    expect(text(view)).toBe('draft')
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
    return [...document.querySelectorAll<HTMLButtonElement>('.attach-menu button')].find((b) => b.textContent?.includes('Screen capture'))!
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
    expect(document.querySelector('.annotate-pins-head')?.textContent).toContain('Pins')
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

  it('opens the annotation canvas on an attached image, without Retake', async () => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    // jsdom decodes no images: this one loads at once with a size.
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 64
        naturalHeight = 48
        onload: (() => void) | null = null
        set src(_: string) {
          setTimeout(() => this.onload?.())
        }
      }
    )
    const start = vi.fn()
    window.gloss = { capture: { start } } as unknown as typeof window.gloss
    mount('attached-image', { accepts: { image: true, file: false } })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' })] } })
    await act(async () => {
      document.querySelector('.box')!.dispatchEvent(drop)
      await new Promise((r) => setTimeout(r, 10))
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.attachment .capture-edit')!.click()
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(document.querySelector('.annotate-head .muted')?.textContent).toBe('photo.jpg · 64 × 48')
    expect([...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent?.includes('Retake'))).toBe(false)
    expect(start).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})


describe('composer conveniences', () => {
  it('swaps stashed drafts and restores their selections across remounts', () => {
    let view = mount('stash-test')
    type(view, 'a larger request')
    act(() => view.dispatch({ selection: EditorSelection.single(2, 7) }))
    press(view, 's', { ctrlKey: true })
    expect(text(view)).toBe('')
    type(view, 'quick question')
    unmount()
    view = mount('stash-test')
    press(view, 's', { ctrlKey: true })
    expect(text(view)).toBe('a larger request')
    expect([view.state.selection.main.anchor, view.state.selection.main.head]).toEqual([2, 7])
    press(view, 's', { ctrlKey: true })
    expect(text(view)).toBe('quick question')
  })

  it('keeps history as arrow recall, with no new action buttons or search panel', () => {
    const view = mount('history-shortcuts', { history: ['fix login', 'add a chart'] })
    expect(document.querySelector('.composer-tools')).toBeNull()
    expect(document.querySelector('button[title*="external editor"]')).toBeNull()
    press(view, 'r', { ctrlKey: true })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    press(view, 'ArrowUp')
    expect(text(view)).toBe('fix login')
  })

  it('attaches selected @ context without sending the message', async () => {
    const onSend = vi.fn()
    const contexts = vi.fn().mockResolvedValue([{ kind: 'file', id: 'src/main.ts', label: 'src/main.ts', description: 'Attach file' }])
    const attachment = { kind: 'file', name: 'main.ts', text: 'hello' }
    const attach = vi.fn().mockResolvedValue(attachment)
    Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { contexts, attach } } })
    const view = mount('mention-test', { sessionId: 'session', onSend, accepts: { file: true, image: true } })
    type(view, 'Look at @main')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)) })
    expect(contexts).toHaveBeenCalledWith('session', 'main')
    await act(async () => { press(view, 'Tab') })
    expect(attach).toHaveBeenCalledWith('session', expect.objectContaining({ id: 'src/main.ts' }))
    expect(text(view)).toBe('Look at ')
    expect(document.querySelector('.attachment-name')?.textContent).toBe('main.ts')
    expect(onSend).not.toHaveBeenCalled()
    press(view, 'Enter')
    expect(onSend).toHaveBeenCalledWith('Look at', [attachment])
  })

  it('automatically restores the edited prompt on editor close, including after switching away', async () => {
    const onSend = vi.fn()
    let complete!: (value: { text: string }) => void
    const editDraft = vi.fn().mockReturnValue(new Promise<{ text: string }>((resolve) => { complete = resolve }))
    Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { editDraft } } })
    const view = mount('editor-auto-test', { onSend })
    type(view, 'original draft')
    press(view, 'g', { ctrlKey: true })
    expect(editDraft).toHaveBeenCalledWith('original draft')
    expect(document.querySelector('.editor-status')?.textContent).toContain('close the file')
    press(view, 'g', { ctrlKey: true })
    expect(editDraft).toHaveBeenCalledTimes(1)
    unmount()
    await act(async () => { complete({ text: 'saved in editor' }) })
    const restored = mount('editor-auto-test', { onSend })
    expect(text(restored)).toBe('saved in editor')
    expect(document.querySelector('.editor-status')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
    press(restored, 's', { ctrlKey: true })
    expect(text(restored)).toBe('original draft')
    editDraft.mockResolvedValueOnce({ text: 'edited again' })
    await act(async () => { press(restored, 'g', { ctrlKey: true }) })
    expect(editDraft).toHaveBeenCalledTimes(2)
    expect(text(restored)).toBe('edited again')
  })

  it('unlocks Ctrl+G after editor errors without losing the draft', async () => {
    const editDraft = vi.fn().mockRejectedValueOnce(new Error('Editor could not start')).mockResolvedValueOnce({ text: 'recovered' })
    Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { editDraft } } })
    const view = mount('editor-retry')
    type(view, 'keep this draft')
    await act(async () => { press(view, 'g', { ctrlKey: true }) })
    expect(text(view)).toBe('keep this draft')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Editor could not start')
    await act(async () => { press(view, 'g', { ctrlKey: true }) })
    expect(text(view)).toBe('recovered')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

})


describe('composer shell mode', () => {
  it('runs ! commands without changing the next message or leaving attachments', async () => {
    const onSend = vi.fn()
    const shell = vi.fn().mockResolvedValue({ command: 'Get-Location', output: 'C:/project', exitCode: 0, truncated: false })
    Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { shell } } })
    const view = mount('shell-auto', { sessionId: 's', onSend, accepts: { image: true, file: true } })
    type(view, '!Get-Location')
    expect(document.querySelector('.send')?.textContent).toBe('Run command')
    expect(document.querySelector('.command-mode')).not.toBeNull()
    await act(async () => { press(view, 'Enter') })
    expect(shell).toHaveBeenCalledExactlyOnceWith('s', 'Get-Location')
    expect(onSend).not.toHaveBeenCalled()
    expect(text(view)).toBe('')
    expect(document.querySelector('.attachment-name')).toBeNull()
    expect(document.querySelector('.command-mode')).toBeNull()
    type(view, 'next request')
    press(view, 'Enter')
    expect(onSend).toHaveBeenCalledWith('next request', [])
  })

  it('finishes commands across composer switches without overwriting new drafts or showing output', async () => {
    let resolve!: (value: unknown) => void
    const shell = vi.fn().mockReturnValue(new Promise((done) => { resolve = done }))
    const cancelShell = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { shell, cancelShell } } })
    const view = mount('shell-switch', { sessionId: 's', accepts: { image: true, file: true } })
    type(view, '!long-command')
    press(view, 'Enter')
    type(view, 'a new draft while command runs')
    expect(document.querySelector<HTMLButtonElement>('.send')?.disabled).toBe(false)
    unmount()
    await act(async () => { resolve({ command: 'long-command', output: 'finished', exitCode: 0, truncated: false }) })
    const restored = mount('shell-switch', { sessionId: 's', accepts: { image: true, file: true } })
    expect(text(restored)).toBe('a new draft while command runs')
    expect(document.querySelector('.attachment-name')).toBeNull()
    expect(document.querySelector('.shell-result')).toBeNull()
    expect(document.body.textContent).not.toContain('finished')
  })

  it('leaves text-only drafts empty after executing shell commands', async () => {
    const onSend = vi.fn()
    const shell = vi.fn().mockResolvedValue({ command: 'echo hello', output: 'hello', exitCode: 0, truncated: false })
    Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { shell } } })
    const view = mount('shell-text', { sessionId: 's', onSend })
    type(view, '!echo hello')
    await act(async () => { press(view, 'Enter') })
    expect(text(view)).toBe('')
    expect(document.querySelector('.shell-result')).toBeNull()
    expect(document.body.textContent).not.toContain('hello')
    expect(onSend).not.toHaveBeenCalled()
    press(view, 'Enter')
    expect(onSend).not.toHaveBeenCalled()
  })
})


describe('Escape and rewind shortcuts', () => {
  it('cancels on one Escape and waits for cancellation when entering rewind on a second tap', async () => {
    const onInterrupt = vi.fn()
    const rewindPoints = vi.fn().mockResolvedValue([{ id: 'm', text: 'sent in this session', threadId: null }])
    Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: { rewindPoints } } })
    const view = mount('escape-rewind', { sessionId: 's', running: true, onInterrupt })
    press(view, 'Escape')
    expect(onInterrupt).toHaveBeenCalledOnce()
    expect(rewindPoints).not.toHaveBeenCalled()
    await act(async () => { press(view, 'Escape') })
    expect(rewindPoints).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(onInterrupt).toHaveBeenCalledOnce()
  })

  it('ignores held Escape and works when reading the log rather than editing', async () => {
    const rewindPoints = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: { rewindPoints } } })
    const view = mount('escape-reading', { sessionId: 's', primary: true })
    press(view, 'Escape', { repeat: true })
    expect(rewindPoints).not.toHaveBeenCalled()
    act(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(rewindPoints).toHaveBeenCalledOnce()
  })

  it('does not treat separated Escape presses or a menu dismissal as a double tap', async () => {
    const clock = vi.spyOn(Date, 'now')
    const rewindPoints = vi.fn().mockResolvedValue([])
    Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: { rewindPoints } } })
    try {
      const view = mount('escape-timing', { sessionId: 's', commands: [{ name: 'compact', description: 'Compact' }] })
      clock.mockReturnValue(1000)
      press(view, 'Escape')
      clock.mockReturnValue(1500)
      press(view, 'Escape')
      expect(rewindPoints).not.toHaveBeenCalled()
      type(view, '/co')
      press(view, 'Escape')
      press(view, 'Escape')
      expect(rewindPoints).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
})


it('scrolls @ selection into view and lets mouse hover pick an entry', async () => {
  const contexts = vi.fn().mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ kind: 'file', id: `file${i}.ts`, label: `file${i}.ts`, description: 'Attach file' })))
  const attach = vi.fn().mockResolvedValue({ kind: 'file', name: 'chosen.ts', text: 'chosen' })
  Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { contexts, attach } } })
  const view = mount('mention-scroll', { sessionId: 's', accepts: { image: true, file: true } })
  type(view, '@file')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)) })
  const options = [...document.querySelectorAll<HTMLElement>('[aria-label="Attach context"] [role="option"]')]
  const scroll = vi.fn()
  options[9].scrollIntoView = scroll
  for (let i = 0; i < 9; i++) press(view, 'ArrowDown')
  expect(options[9].getAttribute('aria-selected')).toBe('true')
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
  act(() => options[4].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
  expect(options[4].getAttribute('aria-selected')).toBe('true')
  await act(async () => { press(view, 'Enter') })
  expect(attach).toHaveBeenCalledWith('s', expect.objectContaining({ id: 'file4.ts' }))
})

it('browses Downloads and quoted paths before attaching a selected file', async () => {
  const contexts = vi.fn().mockImplementation(async (_id: string, query: string) => query === 'Down' ? [
    { kind: 'folder', id: 'C:/My Downloads', label: 'Downloads/', description: 'Browse Downloads', browse: true }
  ] : [{ kind: 'file', id: 'C:/My Downloads/note.txt', label: 'note.txt', description: 'Attach file' }])
  const attach = vi.fn().mockResolvedValue({ kind: 'file', name: 'note.txt', text: 'downloaded note' })
  Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { contexts, attach } } })
  const view = mount('mention-outside', { sessionId: 's', accepts: { image: true, file: true } })
  type(view, 'Read @Down')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)) })
  press(view, 'Tab')
  expect(text(view)).toBe('Read @"C:/My Downloads/')
  expect(attach).not.toHaveBeenCalled()
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)) })
  expect(contexts).toHaveBeenLastCalledWith('s', 'C:/My Downloads/')
  await act(async () => { press(view, 'Enter') })
  expect(attach).toHaveBeenCalledWith('s', expect.objectContaining({ id: 'C:/My Downloads/note.txt' }))
  expect(text(view)).toBe('Read ')
})


it('edits shell commands literally and sends their line breaks unchanged', async () => {
  const shell = vi.fn().mockResolvedValue({ command: 'echo first\necho second', output: '', exitCode: 0, truncated: false })
  Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { shell } } })
  const view = mount('shell-multiline', { sessionId: 's' })
  type(view, '!echo first')
  expect(document.querySelector('.command-mode .md-editor')).not.toBeNull()
  expect(document.querySelector('.shell-mode-hint')).toBeNull()
  press(view, 'Enter', { shiftKey: true })
  expect(text(view)).toBe('!echo first\n')
  type(view, '!echo first\necho second')
  await act(async () => { press(view, 'Enter') })
  expect(shell).toHaveBeenCalledExactlyOnceWith('s', 'echo first\necho second')
  type(view, '!echo - item')
  press(view, 'Enter', { shiftKey: true })
  expect(text(view)).toBe('!echo - item\n')
})


it('clears a nonempty composer on double Escape before offering rewind, and stashes the cleared text', async () => {
  const rewindPoints = vi.fn().mockResolvedValue([])
  const attachment = { kind: 'file', name: 'note.txt', text: 'note' }
  Object.defineProperty(window, 'gloss', { configurable: true, value: {
    sessions: { rewindPoints },
    composer: { contexts: vi.fn().mockResolvedValue([{ kind: 'file', id: 'note.txt', label: 'note.txt', description: 'Attach file' }]), attach: vi.fn().mockResolvedValue(attachment) }
  } })
  const view = mount('escape-clear-first', { sessionId: 's', accepts: { image: true, file: true } })
  type(view, '@note')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 160)) })
  await act(async () => { press(view, 'Tab') })
  expect(document.querySelector('.attachment-name')?.textContent).toBe('note.txt')
  type(view, 'unfinished draft')
  press(view, 'Escape')
  expect(text(view)).toBe('unfinished draft')
  press(view, 'Escape')
  expect(text(view)).toBe('')
  expect(document.querySelector('.attachment-name')).toBeNull()
  expect(rewindPoints).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  press(view, 's', { ctrlKey: true })
  expect(text(view)).toBe('unfinished draft')
  expect(document.querySelector('.attachment-name')?.textContent).toBe('note.txt')
})

it('rejects a legacy editor token instead of inserting it into the prompt', async () => {
  const editDraft = vi.fn().mockResolvedValueOnce('74f4347d-023d-427b-be09-871ebb382ac7').mockResolvedValueOnce({ text: 'fixed prompt' })
  Object.defineProperty(window, 'gloss', { configurable: true, value: { composer: { editDraft } } })
  const view = mount('editor-version-mismatch')
  type(view, 'keep my prompt')
  await act(async () => { press(view, 'g', { ctrlKey: true }) })
  expect(text(view)).toBe('keep my prompt')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Restart Gloss')
  await act(async () => { press(view, 'g', { ctrlKey: true }) })
  expect(text(view)).toBe('fixed prompt')
})


it('restores the full rewound prompt and attachments into the composer without sending', async () => {
  const original = 'A long prompt '.repeat(80)
  const attachment = { kind: 'file', name: 'notes.md', text: 'original context' }
  const rewind = vi.fn().mockRejectedValueOnce(new Error('Could not rewind')).mockResolvedValueOnce({ text: original, attachments: [attachment] })
  const onSend = vi.fn()
  Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: {
    rewindPoints: vi.fn().mockResolvedValue([{ id: 'm', text: original.slice(0, 500), threadId: null }]), rewind
  } } })
  const view = mount('rewind-restore', { sessionId: 'rewind-restore', onSend, accepts: { image: true, file: true } })
  type(view, '/rewind')
  await act(async () => { press(view, 'Enter') })
  const select = async () => act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  await select()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not rewind')
  expect(text(view)).toBe('')
  await select()
  expect(text(view)).toBe(original)
  expect(document.querySelector('.attachment-name')?.textContent).toBe('notes.md')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(onSend).not.toHaveBeenCalled()
  unmount()
  expect(text(mount('rewind-restore', { sessionId: 'rewind-restore' }))).toBe(original)
})

it('restores a rewind draft to the main composer even if its thread panel closes first', async () => {
  let finish!: (draft: { text: string; attachments: [] }) => void
  Object.defineProperty(window, 'gloss', { configurable: true, value: { sessions: {
    rewindPoints: vi.fn().mockResolvedValue([{ id: 'm', text: 'thread prompt', threadId: 'thread' }]),
    rewind: vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve }))
  } } })
  const view = mount('rewind-thread:panel', { sessionId: 'rewind-thread' })
  type(view, '/rewind')
  await act(async () => { press(view, 'Enter') })
  act(() => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  unmount()
  await act(async () => { finish({ text: 'thread prompt', attachments: [] }) })
  expect(text(mount('rewind-thread', { sessionId: 'rewind-thread' }))).toBe('thread prompt')
})
