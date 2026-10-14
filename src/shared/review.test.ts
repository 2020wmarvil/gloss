import { describe, expect, it } from 'vitest'
import { findingsBlocks, findingThread, firstPassPrompt, isFirstPass, lineLabel, linesOf, locate, withoutFindings, type DiffFile, type LineAnchor } from './review'
import type { Thread } from './types'
import { threadTag, threadToMainTag, wireText } from './wire'

function file(lines: [kind: 'context' | 'add' | 'del', text: string][], path = 'src/a.ts', start = 10): DiffFile {
  let o = start
  let n = start
  return {
    path,
    status: 'modified',
    binary: false,
    state: 'committed',
    additions: lines.filter((l) => l[0] === 'add').length,
    deletions: lines.filter((l) => l[0] === 'del').length,
    hunks: [
      {
        header: '@@',
        lines: lines.map(([kind, text]) => ({
          kind,
          old: kind === 'add' ? null : o++,
          new: kind === 'del' ? null : n++,
          text
        }))
      }
    ]
  }
}

const anchor = (start: number, lines: string[], side: 'old' | 'new' = 'new'): LineAnchor => ({
  kind: 'line',
  file: 'src/a.ts',
  side,
  start,
  end: start + lines.length - 1,
  text: lines.join('\n'),
  lines
})

describe('findings', () => {
  it('reads the gloss-findings block and keeps what is valid', () => {
    const text = [
      'Looks fine overall.',
      '',
      '```gloss-findings',
      JSON.stringify([
        { file: './src/a.ts', side: 'new', start: 12, end: 13, severity: 'bug', title: 'Race', body: 'Invalidate later.' },
        { file: 'src/b.ts', start: 4, severity: 'whatever', body: 'Only a body\nsecond line' },
        { file: 'src/c.ts', start: 0, title: 'bad line' },
        { title: 'no file' }
      ]),
      '```',
      'Fix the race first.'
    ].join('\n')
    const [block] = findingsBlocks(text)
    expect(block.findings).toEqual([
      { file: 'src/a.ts', side: 'new', start: 12, end: 13, severity: 'bug', title: 'Race', body: 'Invalidate later.' },
      { file: 'src/b.ts', side: 'new', start: 4, end: 4, severity: 'suggestion', title: 'Only a body', body: 'Only a body\nsecond line' }
    ])
    expect(withoutFindings(text)).toBe('Looks fine overall.\n\nFix the race first.')
  })

  it('lists nothing for a block that is not JSON, or an empty one', () => {
    expect(findingsBlocks('```gloss-findings\n[{oops\n```')[0].findings).toEqual([])
    expect(findingsBlocks('```gloss-findings\n[]\n```')[0].findings).toEqual([])
    expect(findingsBlocks('no block here')).toEqual([])
  })

  it("finds a finding's thread by its lines and title", () => {
    const f = findingsBlocks('```gloss-findings\n[{"file":"src/a.ts","start":3,"end":4,"title":"T"}]\n```')[0].findings[0]
    const thread: Thread = {
      id: 't',
      sessionId: 's',
      anchorMessageId: null,
      anchor: anchor(3, ['x', 'y']),
      finding: { severity: 'suggestion', title: 'T', body: '' },
      createdAt: 0
    }
    expect(findingThread(f, [thread])).toBe(thread)
    expect(findingThread({ ...f, start: 2 }, [thread])).toBeUndefined()
  })

  it('marks the first pass, which names the base', () => {
    const prompt = firstPassPrompt('origin/main', 'abc123')
    expect(isFirstPass(prompt)).toBe(true)
    expect(prompt).toContain('git diff abc123')
    expect(isFirstPass('Review this please')).toBe(false)
  })
})

describe('lines of the diff', () => {
  const f = file([
    ['context', 'a'],
    ['del', 'b'],
    ['add', 'B'],
    ['add', 'C'],
    ['context', 'd']
  ])

  it('reads a range on one side, only if the diff shows all of it', () => {
    expect(linesOf(f, 'new', 11, 12)).toEqual(['B', 'C'])
    expect(linesOf(f, 'old', 11, 11)).toEqual(['b'])
    expect(linesOf(f, 'new', 13, 14)).toBeNull()
  })

  it('re-finds lines that moved, nearest the old position', () => {
    const moved = file([
      ['add', 'new first'],
      ['context', 'a'],
      ['del', 'b'],
      ['add', 'B'],
      ['add', 'C'],
      ['context', 'd']
    ])
    expect(locate(anchor(11, ['B', 'C']), [moved])).toEqual({ kind: 'found', start: 12, end: 13 })
    const twice = file([
      ['add', 'x'],
      ['add', 'y'],
      ['add', 'x'],
      ['add', 'y']
    ])
    expect(locate(anchor(12, ['x', 'y']), [twice])).toEqual({ kind: 'found', start: 12, end: 13 })
  })

  it('marks a thread outdated when its lines are gone, by the nearest line', () => {
    expect(locate(anchor(11, ['B', 'changed']), [f])).toEqual({ kind: 'outdated', at: 11 })
    expect(locate(anchor(11, ['B']), [])).toEqual({ kind: 'gone' })
  })

  it('needs the lines to be consecutive', () => {
    // "a" and "d" are lines 10 and 13: not a match for two lines in a row.
    expect(locate(anchor(10, ['a', 'd']), [f]).kind).toBe('outdated')
  })

  it('labels lines, with the old side marked', () => {
    expect(lineLabel(anchor(12, ['x']))).toBe('src/a.ts:12')
    expect(lineLabel(anchor(12, ['x', 'y'], 'old'))).toBe('src/a.ts:12-13 (old)')
  })
})

describe('wire tags of line threads', () => {
  it('quotes the file and lines', () => {
    const a = anchor(93, ["const out = await run(folder, ['merge-base', branch, 'HEAD'])"])
    expect(threadTag(a)).toBe(`[re: src/a.ts:93 "const out = await run(folder, ['merge-base', branch, 'HEAD'])"]`)
    expect(threadTag({ ...anchor(120, ['a', 'b'], 'old'), text: 'a b' })).toBe('[re: src/a.ts:120-121 (old) "a b"]')
    expect(threadToMainTag(a)).toMatch(/^\[re: src\/a\.ts:93 ".*", continued in the main conversation\]$/)
    expect(wireText('Fix it', a)).toBe(`${threadTag(a)}\nFix it`)
  })

  it('keeps the old form for message anchors', () => {
    expect(threadTag({ kind: 'listItem', path: [0], text: 'Cache race' })).toBe('[re: "Cache race"]')
  })
})
