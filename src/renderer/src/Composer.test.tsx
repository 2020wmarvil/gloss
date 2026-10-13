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

function mount(draftKey: string, opts: { onSend?: (text: string) => void; commands?: SlashCommand[] } = {}): EditorView {
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
        commands={opts.commands ?? []}
        accepts={{ image: false, file: false }}
        queue={{ items: [], paused: false, onEdit: async () => {}, onRemove: async () => {}, onResume: async () => {} }}
        onSend={opts.onSend ?? (() => {})}
        onCancel={() => {}}
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
