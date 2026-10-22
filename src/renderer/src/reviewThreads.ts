// Review threads as the diff, the overview and the thread panel show them (SPEC → Review sessions).
import { lineLabel, locate, type LineAnchor, type Location, type ReviewDiff } from '@shared/review'
import type { Message, Severity, Thread } from '@shared/types'
import { truncate } from '@shared/wire'

/** A finding's severity, or "you" for a thread the user started. */
export type ThreadKind = Severity | 'you'

export type LineThread = Thread & { anchor: LineAnchor }

export function isLineThread(t: Thread): t is LineThread {
  return t.anchor.kind === 'line'
}

export function kindOf(t: Thread): ThreadKind {
  return t.finding?.severity ?? 'you'
}

export const KIND_NAMES: Record<ThreadKind, string> = { bug: 'Bug', suggestion: 'Suggestion', nit: 'Nit', you: 'Yours' }

/** The finding's title, or the start of the user's first message, or the lines. */
export function titleOf(t: LineThread, messages: Message[]): string {
  if (t.finding) return t.finding.title
  const first = messages.find((m) => m.threadId === t.id && m.role === 'user')
  return first ? truncate(first.text, 90) : lineLabel(t.anchor)
}

/**
 * Where each line thread is in the diff now, and in the unchanged lines around it for
 * the files read (`sources`); every thread is `gone` without a diff.
 */
export function locations(threads: Thread[], diff: ReviewDiff | null, sources: Record<string, string[] | null> = {}): Map<string, Location> {
  const out = new Map<string, Location>()
  for (const t of threads) {
    if (isLineThread(t)) out.set(t.id, diff ? locate(t.anchor, diff.files, sources) : { kind: 'gone' })
  }
  return out
}

/** The line a thread is shown at: its first line, where its lines were, or its original start. */
export function shownLine(t: LineThread, at: Location | undefined): number {
  if (at?.kind === 'found') return at.start
  if (at?.kind === 'outdated' && at.at !== null) return at.at
  return t.anchor.start
}

/** Line threads in diff order: by file as the diff lists them (files no longer in it last), then by line. */
export function inDiffOrder(threads: Thread[], diff: ReviewDiff | null, at: Map<string, Location>): LineThread[] {
  const fileIndex = new Map((diff?.files ?? []).map((f, i) => [f.path, i]))
  const rank = (t: LineThread): number => fileIndex.get(t.anchor.file) ?? Number.MAX_SAFE_INTEGER
  return threads
    .filter(isLineThread)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.anchor.file.localeCompare(b.anchor.file) ||
        shownLine(a, at.get(a.id)) - shownLine(b, at.get(b.id)) ||
        a.createdAt - b.createdAt
    )
}
