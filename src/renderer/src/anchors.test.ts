import { describe, expect, it } from 'vitest'
import { itemSource, listItemSpans } from './anchors'

const REVIEW = [
  'Here is what I found in `services/orders`:',
  '',
  '1. **Cache invalidation races the write path.** `invalidate()` runs before commit.',
  '2. **N+1 query** in GET /orders:',
  '   - about 40 queries',
  '   - per page',
  '3. Plain item',
  '',
  'And a second list:',
  '',
  '- First bullet',
  '- Second <b>bullet</b>',
  '',
  '> - quoted list (not top-level)',
  ''
].join('\n')

describe('listItemSpans', () => {
  it('finds top-level items across lists, in order, with source offsets', () => {
    const spans = listItemSpans(REVIEW)
    expect(spans.map((s) => s.index)).toEqual([0, 1, 2, 3, 4])
    expect(spans.map((s) => s.text)).toEqual([
      'Cache invalidation races the write path. invalidate() runs before commit.',
      'N+1 query in GET /orders: about 40 queries per page',
      'Plain item',
      'First bullet',
      'Second <b>bullet</b>'
    ])
    for (const s of spans) expect(REVIEW.slice(s.start, s.end)).toMatch(/^(\d\.|-) /)
  })

  it('quotes an item without its marker', () => {
    const [first] = listItemSpans(REVIEW)
    expect(itemSource(REVIEW, first)).toBe(
      '**Cache invalidation races the write path.** `invalidate()` runs before commit.'
    )
  })

  it('returns nothing for messages without lists', () => {
    expect(listItemSpans('Just prose.\n\n```\n1. not a list\n```')).toEqual([])
  })
})
