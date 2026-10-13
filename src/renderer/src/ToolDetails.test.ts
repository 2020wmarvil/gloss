import { describe, expect, it } from 'vitest'
import { diffRows } from './ToolDetails'

describe('diffRows', () => {
  it('marks added and removed lines and keeps context', () => {
    expect(diffRows('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' }
    ])
  })

  it('collapses long unchanged stretches', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const rows = diffRows(old, old.replace('line 10', 'changed'))
    expect(rows.filter((r) => r.kind === 'gap').map((r) => r.text)).toEqual(['7 unchanged lines', '6 unchanged lines'])
    expect(rows.filter((r) => r.kind === 'same')).toHaveLength(6)
  })

  it('treats a new file as all additions', () => {
    expect(diffRows('', 'x\ny\n')).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' }
    ])
  })
})
