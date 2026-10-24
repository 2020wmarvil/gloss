import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { indentLines, inCodeBlock, insertLink, shiftListItem, toggleWrap } from './MarkdownEditor'

/** A document with "|" as the cursor, or "«" and "»" around the selection. */
function make(doc: string): EditorState {
  const cursor = doc.indexOf('|')
  const from = cursor >= 0 ? cursor : doc.indexOf('«')
  const to = cursor >= 0 ? cursor : doc.indexOf('»') - 1
  const text = cursor >= 0 ? doc.replace('|', '') : doc.replace('«', '').replace('»', '')
  const state = EditorState.create({
    doc: text,
    selection: EditorSelection.single(from, to),
    extensions: markdown({ base: markdownLanguage, completeHTMLTags: false })
  })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return state
}

/** Runs a command; returns the text with the selection marked, or null if it didn't apply. */
function run(command: StateCommand, doc: string): string | null {
  let state = make(doc)
  const ok = command({ state, dispatch: (tr) => (state = tr.state) })
  if (!ok) return null
  const { from, to } = state.selection.main
  const text = state.doc.toString()
  return from === to ? text.slice(0, from) + '|' + text.slice(from) : text.slice(0, from) + '«' + text.slice(from, to) + '»' + text.slice(to)
}

describe('formatting keys', () => {
  it('wraps, unwraps and inserts a pair for an empty selection', () => {
    expect(run(toggleWrap('**'), 'a «word» b')).toBe('a **«word»** b')
    expect(run(toggleWrap('**'), 'a **«word»** b')).toBe('a «word» b')
    expect(run(toggleWrap('**'), 'a «**word**» b')).toBe('a «word» b')
    expect(run(toggleWrap('`'), 'x |')).toBe('x `|`')
  })

  it('makes a link with the URL selected', () => {
    expect(run(insertLink, 'see «docs» now')).toBe('see [docs](«url») now')
    expect(run(insertLink, '|')).toBe('[|](url)')
  })
})

describe('list indentation', () => {
  it('nests an item under the one before at its text column, and back out', () => {
    expect(run(shiftListItem(1), '- one\n- tw|o')).toBe('- one\n  - tw|o')
    expect(run(shiftListItem(1), '1. one\n2. tw|o')).toBe('1. one\n   1. tw|o')
    expect(run(shiftListItem(-1), '- one\n  - tw|o')).toBe('- one\n- tw|o')
  })

  it('renumbers an ordered item for where it lands', () => {
    expect(run(shiftListItem(1), '1. one\n   1. sub\n2. tw|o')).toBe('1. one\n   1. sub\n   2. tw|o')
    expect(run(shiftListItem(-1), '1. one\n   1. sub\n   2. tw|o')).toBe('1. one\n   1. sub\n2. tw|o')
  })

  it("leaves the first item alone, and isn't used outside a list", () => {
    expect(run(shiftListItem(1), '- on|e')).toBe('- on|e')
    expect(run(shiftListItem(1), 'plain|')).toBeNull()
  })
})

describe('line indentation', () => {
  it('indents the line by two spaces from anywhere on it, and takes them back', () => {
    expect(run(indentLines(1), 'a|b')).toBe('  a|b')
    expect(run(indentLines(1), '|')).toBe('  |')
    expect(run(indentLines(-1), '   a|b')).toBe(' a|b')
    expect(run(indentLines(-1), ' a|b')).toBe('a|b')
    // Nothing to take away: it still keeps the key.
    expect(run(indentLines(-1), 'a|b')).toBe('a|b')
  })

  it('indents every line of the selection, not the one it ends at the start of', () => {
    expect(run(indentLines(1), '«one\ntwo\n»three')).toBe('  «one\n  two\n»three')
    expect(run(indentLines(-1), '  «one\n  two»')).toBe('«one\ntwo»')
  })
})

describe('inCodeBlock', () => {
  it('is true inside an open or closed fence, not after it', () => {
    const open = make('```ts\nconst a = 1|')
    expect(inCodeBlock(open, open.selection.main.head)).toBe(true)
    const closed = '```\ncode\n```\nafter'
    const state = make(closed + '|')
    expect(inCodeBlock(state, closed.indexOf('code') + 2)).toBe(true)
    expect(inCodeBlock(state, closed.length)).toBe(false)
    expect(inCodeBlock(state, closed.indexOf('after') - 1)).toBe(false)
  })
})
