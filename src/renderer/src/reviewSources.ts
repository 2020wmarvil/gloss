// The files of a review's diff at the reviewed commit, read for the unchanged lines
// around their hunks (SPEC → Review sessions → Diff view): when the user shows more of a
// file, and for files with threads, whose lines may be outside the hunks.
import { useCallback, useEffect, useRef, useState } from 'react'
import { expandable, type ReviewDiff, type ReviewRange } from '@shared/review'
import type { Thread } from '@shared/types'

export type Sources = Record<string, string[] | null>

export function useReviewSources(
  sessionId: string | null,
  review: ReviewRange | undefined,
  diff: ReviewDiff | null,
  threads: Thread[]
): { sources: Sources; read(path: string): void } {
  const [sources, setSources] = useState<Sources>({})
  /** Paths whose file is read, or being read. */
  const reading = useRef(new Set<string>())
  /** Bumped when the session or range changes, so earlier reads are dropped. */
  const generation = useRef(0)

  const read = useCallback(
    (path: string) => {
      if (!sessionId) return
      reading.current.add(path)
      const at = generation.current
      window.gloss.sessions
        .reviewFile(sessionId, path)
        .catch(() => null)
        .then((lines) => {
          if (generation.current === at) setSources((s) => ({ ...s, [path]: lines }))
        })
    },
    [sessionId]
  )

  // Another session or range is another diff: nothing read yet.
  const rangeKey = review ? `${sessionId}\0${review.baseRef}\0${review.headRef ?? ''}` : ''
  useEffect(() => {
    generation.current++
    reading.current.clear()
    setSources({})
  }, [rangeKey])

  // Files read follow the diff as it is re-read.
  useEffect(() => {
    for (const path of reading.current) read(path)
  }, [diff, read])

  // Files with threads, so threads on unchanged lines are found.
  useEffect(() => {
    if (!diff) return
    for (const t of threads) {
      const anchor = t.anchor
      if (anchor.kind !== 'line' || reading.current.has(anchor.file)) continue
      const file = diff.files.find((f) => f.path === anchor.file)
      if (file && expandable(file)) read(file.path)
    }
  }, [diff, threads, read])

  return { sources, read }
}
