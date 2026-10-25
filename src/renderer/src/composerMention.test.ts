import { expect, it } from 'vitest'
import { composerMention, mentionPrefix } from './composerMention'

it('finds ordinary mentions and quoted external paths at the caret', () => {
  const text = 'Read @"C:/My Downloads/note'
  expect(composerMention(text, text.length)).toEqual({ query: 'C:/My Downloads/note', start: 5, end: text.length })
  expect(composerMention(`${text}"`, text.length + 1)?.query).toBe('C:/My Downloads/note')
  expect(composerMention('Read @~/Downloads/', 18)?.query).toBe('~/Downloads/')
  expect(composerMention('a@b.com', 7)).toBeNull()
  expect(mentionPrefix('C:/My Downloads/')).toBe('@"C:/My Downloads/')
})
