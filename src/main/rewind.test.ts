import { describe, expect, it } from 'vitest'
import { claudeForkBoundary } from './rewind'

// Transcript entries as Claude Code writes them, linked by parentUuid.
const entry = (type: string, uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> & { type: string } =>
  ({ type, uuid, parentUuid, ...extra })

describe('claudeForkBoundary', () => {
  it('keeps a cancelled turn whole, ending on its interrupt marker', () => {
    const entries = [
      entry('user', 'p1', null),
      entry('assistant', 'a1', 'p1'),
      entry('user', 'result', 'a1'),
      entry('user', 'interrupt', 'result'),
      entry('user', 'p2', 'interrupt')
    ]
    expect(claudeForkBoundary(entries, 'p2')).toBe('interrupt')
  })

  it('skips entries that are not messages, and side chains', () => {
    const entries = [
      entry('user', 'p1', null),
      entry('assistant', 'a1', 'p1'),
      entry('assistant', 'side', 'a1', { isSidechain: true }),
      entry('system', 'hook', 'side'),
      entry('user', 'p2', 'hook')
    ]
    expect(claudeForkBoundary(entries, 'p2')).toBe('a1')
  })

  it('reaches a point before a compaction, which is off the active history', () => {
    const entries = [
      entry('user', 'apple', null),
      entry('assistant', 'a-apple', 'apple'),
      entry('user', 'banana', 'a-apple'),
      entry('assistant', 'a-banana', 'banana'),
      entry('system', 'boundary', null, { subtype: 'compact_boundary' }),
      entry('user', 'summary', 'boundary')
    ]
    expect(claudeForkBoundary(entries, 'banana')).toBe('a-apple')
  })

  it('is null for the first message and fails for one it cannot find', () => {
    const entries = [entry('system', 'start', null), entry('user', 'p1', 'start')]
    expect(claudeForkBoundary(entries, 'p1')).toBeNull()
    expect(() => claudeForkBoundary(entries, 'gone')).toThrow("Couldn't find that message")
  })
})
