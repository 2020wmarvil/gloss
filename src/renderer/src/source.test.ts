import { describe, expect, it } from 'vitest'
import { align, findText, renderedText, resolveSelection } from './source'

const MD = [
  'The retry wrapper looks **fine overall**, and the `classify()` call is correct.',
  '',
  '> One concern: backoff resets on every',
  '> reconnect, so a flapping connection never backs off.',
  '',
  '1. Drop the custom jitter \\*and\\* use the library option.',
  '2. Add a test &amp; a metric.',
  '',
  '```ts',
  'const delay = base * 2 ** attempt',
  '```',
  '',
  'Want me to make both changes? Want me to?',
  ''
].join('\n')

const at = (needle: string): number => {
  const i = MD.indexOf(needle)
  if (i === -1) throw new Error(`not in MD: ${needle}`)
  return i
}

describe('align', () => {
  it('maps rendered characters to source positions, skipping markup', () => {
    expect(align('a*b', 'a\\*b')).toEqual([0, 2, 3])
    expect(align('x\ny', '> x\n> y')).toEqual([2, 3, 6])
    expect(align('code\n', '```ts\ncode\n```', true)).toEqual([6, 7, 8, 9, 10])
  })
})

describe('renderedText', () => {
  it('shows what the reader sees for a source range, without markup', () => {
    expect(renderedText(MD, at('looks'), at(', and'))).toBe('looks fine overall')
    expect(renderedText(MD, at('the `classify'), at(' call'))).toBe('the classify()')
    expect(renderedText(MD, at('backoff'), at(' never'))).toBe(
      'backoff resets on every reconnect, so a flapping connection'
    )
    expect(renderedText(MD, at('custom'), at(' use'))).toBe('custom jitter *and*')
    expect(renderedText(MD, at('test &amp;'), at(' a metric'))).toBe('test &')
    expect(renderedText(MD, at('delay'), at(' * 2'))).toBe('delay = base')
  })

  it('joins text across blocks with a space', () => {
    expect(renderedText(MD, at('correct.'), at('concern'))).toBe('correct. One')
    expect(renderedText(MD, at('option.'), at(' a metric'))).toBe('option. Add a test &')
  })
})

describe('findText and resolveSelection', () => {
  it('finds rendered text across markup and line breaks', () => {
    const r = findText(MD, 'fine overall, and the classify() call')!
    expect(MD.slice(r.start, r.end)).toBe('fine overall**, and the `classify()` call')
    const q = findText(MD, 'every reconnect')!
    expect(MD.slice(q.start, q.end)).toBe('every\n> reconnect')
  })

  it('keeps stored offsets that still match', () => {
    const start = at('flapping')
    const anchor = { start, end: start + 'flapping connection'.length, text: 'flapping connection' }
    expect(resolveSelection(MD, anchor)).toEqual({ start: anchor.start, end: anchor.end })
  })

  it('re-finds the text when offsets have drifted, preferring the nearest match', () => {
    const shifted = 'Pre.\n\n' + MD
    // "Want me to" occurs twice; the anchor is on the second one.
    const start = at('Want me to?')
    const anchor = { start, end: start + 'Want me to'.length, text: 'Want me to' }
    const r = resolveSelection(shifted, anchor)!
    expect(r.start).toBe(shifted.indexOf('Want me to?'))
    expect(shifted.slice(r.start, r.end)).toBe('Want me to')
  })

  it('returns null when the text is gone', () => {
    expect(resolveSelection(MD, { start: 0, end: 5, text: 'no such words here' })).toBeNull()
  })
})
