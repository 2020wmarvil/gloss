// The unchanged lines of a file between its diff's hunks, which the diff view can show
// on request (SPEC → Review sessions → Diff view). They come from the file as it is now.
import type { DiffFile, DiffHunk, DiffLine } from '@shared/review'

/** Lines one click on an expander shows. */
export const EXPAND_STEP = 10

/** What the user has shown of a file beyond its hunks: lines from each end of each gap, or all of it. */
export type Expansion = { full: boolean; gaps: Record<number, { top: number; bottom: number }> }

export const NO_EXPANSION: Expansion = { full: false, gaps: {} }

/**
 * The unchanged lines before hunk `index` (index = hunks.length: after the last hunk),
 * as new-side numbers from `from` to `to` (null: to the end of the file). A line's
 * number in the base is its new number plus `delta`.
 */
export type Gap = { index: number; from: number; to: number | null; delta: number }

/** A gap as shown: the lines shown from its top and bottom, and how many are still hidden (null: unknown). */
export type GapView = { gap: Gap; top: DiffLine[]; bottom: DiffLine[]; hidden: number | null }

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

type Span = { first: number; after: number }

/** A hunk's first line on one side and the line after it. A side with no lines starts after the line its header names. */
function span(start: string, length: string | undefined): Span {
  const n = length === undefined ? 1 : Number(length)
  const first = n === 0 ? Number(start) + 1 : Number(start)
  return { first, after: first + n }
}

/** The gaps around a file's hunks, one before each hunk and one after the last. Null if a header can't be read. */
export function gapsOf(hunks: DiffHunk[]): Gap[] | null {
  const spans: { old: Span; new: Span }[] = []
  for (const h of hunks) {
    const m = HEADER.exec(h.header)
    if (!m) return null
    spans.push({ old: span(m[1], m[2]), new: span(m[3], m[4]) })
  }
  if (spans.length === 0) return []
  const gaps: Gap[] = spans.map((s, i) => ({
    index: i,
    from: i === 0 ? 1 : spans[i - 1].new.after,
    to: s.new.first - 1,
    delta: s.old.first - s.new.first
  }))
  const last = spans[spans.length - 1]
  gaps.push({ index: spans.length, from: last.new.after, to: null, delta: last.old.after - last.new.after })
  return gaps
}

/** Whether lines around a file's hunks can be shown: a text file that exists on both sides. */
export function expandable(file: DiffFile): boolean {
  return !file.binary && file.hunks.length > 0 && file.status !== 'added' && file.status !== 'deleted'
}

/**
 * Each gap with the lines the expansion shows from `source` (the file now). Without
 * the source nothing is shown, and the last gap's size is unknown.
 */
export function gapViews(gaps: Gap[], source: string[] | null | undefined, expansion: Expansion): GapView[] {
  return gaps.map((gap) => {
    if (!source) {
      return { gap, top: [], bottom: [], hidden: gap.to === null ? null : Math.max(0, gap.to - gap.from + 1) }
    }
    // The file may have changed since the diff was read: keep within it.
    const to = Math.min(gap.to ?? source.length, source.length)
    const size = Math.max(0, to - gap.from + 1)
    const shown = expansion.gaps[gap.index] ?? { top: 0, bottom: 0 }
    const top = expansion.full ? size : Math.min(shown.top, size)
    const bottom = expansion.full ? 0 : Math.min(shown.bottom, size - top)
    const line = (n: number): DiffLine => ({ kind: 'context', old: n + gap.delta, new: n, text: source[n - 1] })
    return {
      gap,
      top: Array.from({ length: top }, (_, k) => line(gap.from + k)),
      bottom: Array.from({ length: bottom }, (_, k) => line(to - bottom + 1 + k)),
      hidden: size - top - bottom
    }
  })
}

/** The expansion after a click: more lines from one end of a gap, all of it, or the whole file on or off. */
export function expand(e: Expansion, how: { gap: number; edge: 'top' | 'bottom' | 'all' } | 'full'): Expansion {
  if (how === 'full') return e.full ? NO_EXPANSION : { full: true, gaps: {} }
  const g = e.gaps[how.gap] ?? { top: 0, bottom: 0 }
  const next =
    how.edge === 'all'
      ? { top: Infinity, bottom: 0 }
      : how.edge === 'top'
        ? { ...g, top: g.top + EXPAND_STEP }
        : { ...g, bottom: g.bottom + EXPAND_STEP }
  return { ...e, gaps: { ...e.gaps, [how.gap]: next } }
}
