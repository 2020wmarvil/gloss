import { describe, expect, it } from 'vitest'
import { bulletOnBackspace, bulletOnNewline, bulletOnSpace, bulletsToMarkdown, splitLists } from './bullets'

describe('bullet edits', () => {
  it('makes a bullet only from a leading "*", keeping the indent', () => {
    expect(bulletOnSpace('*', 1)).toEqual({ start: 0, end: 1, insert: '• ' })
    expect(bulletOnSpace('a\n  *', 5)).toEqual({ start: 4, end: 5, insert: '• ' })
    expect(bulletOnSpace('a *', 3)).toBeNull()
    expect(bulletOnSpace('**', 2)).toBeNull()
  })

  it('continues a bullet line, splitting it at the caret, and ends the list at an empty one', () => {
    expect(bulletOnNewline('  • one', 7)).toEqual({ start: 7, end: 7, insert: '\n  • ' })
    expect(bulletOnNewline('• onetwo', 5)).toEqual({ start: 5, end: 5, insert: '\n• ' })
    expect(bulletOnNewline('• one\n  • ', 10)).toEqual({ start: 6, end: 10, insert: '' })
    expect(bulletOnNewline('plain', 5)).toBeNull()
  })

  it('removes the bullet on Backspace right after it', () => {
    expect(bulletOnBackspace('x\n  • text', 6)).toEqual({ start: 4, end: 6, insert: '' })
    expect(bulletOnBackspace('• te', 4)).toBeNull()
  })

  it('sends bullets as markdown list items', () => {
    expect(bulletsToMarkdown('Do:\n• one\n  • nested\nnot • this')).toBe('Do:\n- one\n  - nested\nnot • this')
  })
})

describe('splitLists', () => {
  it('groups bulleted lines into lists between plain text', () => {
    expect(splitLists('Do:\n- one\n* two\nthanks')).toEqual([
      { kind: 'text', text: 'Do:' },
      { kind: 'list', items: ['one', 'two'] },
      { kind: 'text', text: 'thanks' }
    ])
  })

  it('leaves code fences and lines without a space after the marker alone', () => {
    expect(splitLists('```\n- removed\n```\n-5 degrees')).toEqual([{ kind: 'text', text: '```\n- removed\n```\n-5 degrees' }])
  })
})
