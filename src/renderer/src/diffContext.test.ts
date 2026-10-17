import { describe, expect, it } from 'vitest'
import { expandable, gapsOf, type DiffFile, type DiffHunk } from '@shared/review'
import { expand, gapViews, NO_EXPANSION, revealing } from './diffContext'

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

describe('revealing', () => {
  const gaps = gapsOf([hunk('@@ -5,3 +5,4 @@'), hunk('@@ -20,3 +21,2 @@')])!
  const found = (start: number, end = start) => ({ kind: 'found' as const, start, end })

  it("shows a thread's lines from the nearer end of their gap, with a few around them", () => {
    // Gap 1 is lines 9-20: line 18 is nearer the bottom.
    const e = revealing(NO_EXPANSION, gaps, source.length, [{ side: 'new', location: found(18) }])
    expect(e.gaps[1]).toEqual({ top: 0, bottom: 6 })
    expect(gapViews(gaps, source, e)[1].bottom.map((l) => l.new)).toEqual([15, 16, 17, 18, 19, 20])
    // Old line 12 is line 13 now, nearer the top.
    expect(revealing(NO_EXPANSION, gaps, source.length, [{ side: 'old', location: found(12) }]).gaps[1]).toEqual({ top: 8, bottom: 0 })
    // Where an outdated thread's lines were, too.
    expect(revealing(NO_EXPANSION, gaps, source.length, [{ side: 'new', location: { kind: 'outdated', at: 2 } }]).gaps[0]).toEqual({ top: 5, bottom: 0 })
  })

  it('leaves lines already shown, and threads in the hunks', () => {
    const shown = expand(NO_EXPANSION, { gap: 1, edge: 'top' })
    expect(revealing(shown, gaps, source.length, [{ side: 'new', location: found(14, 15) }])).toBe(shown)
    expect(revealing(NO_EXPANSION, gaps, source.length, [{ side: 'new', location: found(6) }])).toBe(NO_EXPANSION)
    expect(revealing(NO_EXPANSION, gaps, source.length, [{ side: 'new', location: { kind: 'outdated', at: null } }])).toBe(NO_EXPANSION)
  })
})

it('expands only text files present on both sides', () => {
  const file: DiffFile = { path: 'a', status: 'modified', binary: false, state: 'committed', additions: 1, deletions: 0, hunks: [hunk('@@ -1 +1 @@')] }
  expect(expandable(file)).toBe(true)
  expect(expandable({ ...file, status: 'added' })).toBe(false)
  expect(expandable({ ...file, binary: true })).toBe(false)
  expect(expandable({ ...file, hunks: [] })).toBe(false)
})
