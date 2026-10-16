import { describe, expect, it } from 'vitest'
import type { DiffFile, DiffHunk } from '@shared/review'
import { expand, expandable, gapsOf, gapViews, NO_EXPANSION } from './diffContext'

const hunk = (header: string): DiffHunk => ({ header, lines: [] })
const source = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`)

describe('gapsOf', () => {
  it('finds the unchanged lines around each hunk, with the offset to the base', () => {
    // Lines 5-7 become 5-8 (one added), then lines 20-22 become 21-22 (one removed).
    expect(gapsOf([hunk('@@ -5,3 +5,4 @@ fn'), hunk('@@ -20,3 +21,2 @@')])).toEqual([
      { index: 0, from: 1, to: 4, delta: 0 },
      { index: 1, from: 9, to: 20, delta: -1 },
      { index: 2, from: 23, to: null, delta: 0 }
    ])
  })

  it('reads headers with no lines on one side, and without counts', () => {
    // Two lines inserted after line 3, then line 10 changed.
    expect(gapsOf([hunk('@@ -3,0 +4,2 @@'), hunk('@@ -10 +12 @@')])).toEqual([
      { index: 0, from: 1, to: 3, delta: 0 },
      { index: 1, from: 6, to: 11, delta: -2 },
      { index: 2, from: 13, to: null, delta: -2 }
    ])
    expect(gapsOf([hunk('not a header')])).toBeNull()
  })
})

describe('gapViews', () => {
  const gaps = gapsOf([hunk('@@ -5,3 +5,4 @@'), hunk('@@ -20,3 +21,2 @@')])!

  it('shows nothing until the file is read, and the last gap has no known size', () => {
    expect(gapViews(gaps, undefined, NO_EXPANSION).map((g) => g.hidden)).toEqual([4, 12, null])
  })

  it('shows lines from either end of a gap, numbered on both sides', () => {
    let e = expand(NO_EXPANSION, { gap: 1, edge: 'top' })
    e = expand(e, { gap: 1, edge: 'bottom' })
    const [, middle, end] = gapViews(gaps, source, e)
    // 12 lines: 10 from the top, the remaining 2 from the bottom.
    expect(middle.top.map((l) => [l.old, l.new, l.text])[0]).toEqual([8, 9, 'line 9'])
    expect(middle.top).toHaveLength(10)
    expect(middle.bottom.map((l) => l.new)).toEqual([19, 20])
    expect(middle.hidden).toBe(0)
    expect(end.hidden).toBe(18)
  })

  it('shows every line of the file, or a whole gap', () => {
    const all = gapViews(gaps, source, expand(NO_EXPANSION, 'full'))
    expect(all.map((g) => [g.top.length, g.hidden])).toEqual([[4, 0], [12, 0], [18, 0]])
    expect(expand(expand(NO_EXPANSION, 'full'), 'full')).toEqual(NO_EXPANSION)
    expect(gapViews(gaps, source, expand(NO_EXPANSION, { gap: 2, edge: 'all' }))[2].hidden).toBe(0)
  })

  it('keeps within a file that got shorter', () => {
    expect(gapViews(gaps, source.slice(0, 15), expand(NO_EXPANSION, 'full')).map((g) => g.top.length)).toEqual([4, 7, 0])
  })
})

it('expands only text files present on both sides', () => {
  const file: DiffFile = { path: 'a', status: 'modified', binary: false, state: 'committed', additions: 1, deletions: 0, hunks: [hunk('@@ -1 +1 @@')] }
  expect(expandable(file)).toBe(true)
  expect(expandable({ ...file, status: 'added' })).toBe(false)
  expect(expandable({ ...file, binary: true })).toBe(false)
  expect(expandable({ ...file, hunks: [] })).toBe(false)
})
