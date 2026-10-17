// The unchanged lines of a file between its diff's hunks, which the diff view can show
// on request (SPEC → Review sessions → Diff view). They come from the file at the
// reviewed commit (the working tree's file when that is reviewed).
import type { DiffLine, Gap, Location, Side } from '@shared/review'

/** Lines one click on an expander shows. */
export const EXPAND_STEP = 10

/** What the user has shown of a file beyond its hunks: lines from each end of each gap, or all of it. */
export type Expansion = { full: boolean; gaps: Record<number, { top: number; bottom: number }> }

export const NO_EXPANSION: Expansion = { full: false, gaps: {} }

/** A gap as shown: the lines shown from its top and bottom, and how many are still hidden (null: unknown). */
export type GapView = { gap: Gap; top: DiffLine[]; bottom: DiffLine[]; hidden: number | null }

/**
 * Each gap with the lines the expansion shows from `source` (the file at the reviewed commit). Without
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

/** Lines shown around a thread's lines when they are outside the hunks. */
export const AROUND_THREAD = 3

/**
 * The expansion with the lines each thread is at shown, when they are in a gap: from
 * the nearer end of the gap, with a few lines around them. `lines` is the file's length.
 */
export function revealing(e: Expansion, gaps: Gap[], lines: number, threads: { side: Side; location: Location }[]): Expansion {
  if (e.full) return e
  let out = e
  for (const { side, location } of threads) {
    const range =
      location.kind === 'found'
        ? location
        : location.kind === 'outdated' && location.at !== null
          ? { start: location.at, end: location.at }
          : null
    if (!range) continue
    for (const g of gaps) {
      const shift = side === 'old' ? g.delta : 0
      const to = Math.min(g.to ?? lines, lines)
      const start = Math.max(range.start - shift, g.from)
      const end = Math.min(range.end - shift, to)
      if (start > end) continue
      const shown = out.gaps[g.index] ?? { top: 0, bottom: 0 }
      const top = end - g.from + 1 + AROUND_THREAD
      const bottom = to - start + 1 + AROUND_THREAD
      // Already shown from either end.
      if (shown.top >= end - g.from + 1 || shown.bottom >= to - start + 1) continue
      const next = top <= bottom ? { ...shown, top } : { ...shown, bottom }
      out = { ...out, gaps: { ...out.gaps, [g.index]: next } }
    }
  }
  return out
}
