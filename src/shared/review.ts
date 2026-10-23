// Review sessions (SPEC → Review sessions): the diff under review, the agent's
// findings, and where a thread's lines are now. Pure, so main and renderer share it.
import type { Anchor, Finding, Severity, Thread } from './types'

export type LineAnchor = Extract<Anchor, { kind: 'line' }>
export type Side = 'old' | 'new'

export type DiffLine = {
  kind: 'context' | 'add' | 'del'
  /** Its number in the base; null for an added line. */
  old: number | null
  /** Its number now; null for a removed line. */
  new: number | null
  text: string
}

export type DiffHunk = { header: string; lines: DiffLine[] }

export type DiffFile = {
  path: string
  /** The path in the base, for a renamed file. */
  oldPath?: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  binary: boolean
  /** Whether its changes are committed on the branch, still in the working tree, or both. */
  state: 'committed' | 'uncommitted' | 'both'
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

/**
 * What a review compares (SPEC → Review sessions → What is reviewed). `baseRef` is a
 * commit id (40 hex digits), used as is, or a branch such as "origin/main", whose merge
 * base with the reviewed commit is used. `headRef` is a commit id or "HEAD"; without one
 * the working tree is reviewed, uncommitted changes and new files included.
 */
export type ReviewRange = { baseRef: string; headRef?: string }

/** Whether a baseRef names one commit rather than a branch to take the merge base with. */
export function isCommitId(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref)
}

export type ReviewDiff = {
  baseRef: string
  /** The commit reviewed against: baseRef itself, or its merge base with the reviewed commit. */
  base: string
  /** Null for the working tree. */
  headRef: string | null
  /** The reviewed commit; for the working tree, HEAD's. */
  head: string
  files: DiffFile[]
}

/** A commit the review's dropdowns offer. */
export type ReviewCommit = { sha: string; subject: string; /** Commit time, ms. */ at: number }

/** What the review's dropdowns offer: branches to take the merge base with, and the branch's recent commits. */
export type ReviewRefs = {
  bases: { ref: string; sha: string }[]
  commits: ReviewCommit[]
  /** The repository's GitHub page (from `origin`), for links to commits; null off GitHub. */
  repoUrl: string | null
  /** The base a new review starts with (the open pull request's base, else the default branch); null if none. */
  defaultBase: string | null
}

/** The diff a range shows, as a command (for the agent). */
export function diffCommand(diff: Pick<ReviewDiff, 'base' | 'headRef' | 'head'>): string {
  return diff.headRef === null
    ? `\`git diff ${diff.base}\` (it includes uncommitted changes) plus new files from \`git ls-files --others --exclude-standard\``
    : `\`git diff ${diff.base} ${diff.head}\``
}

/** The first line of a message after the review's range changed, so the agent reviews the new diff. */
export function rangeNote(diff: Pick<ReviewDiff, 'base' | 'headRef' | 'head'>): string {
  return `[The diff under review is now ${diffCommand(diff)}.]`
}

/** Whether a line is a range note. */
export function isRangeNote(line: string): boolean {
  return line.startsWith('[The diff under review is now ') && line.endsWith('.]')
}

export const SEVERITIES: Severity[] = ['bug', 'suggestion', 'nit']

/** Files with more changed lines than this start collapsed. */
export const LARGE_FILE_LINES = 1000

// Agent instructions and the first pass

/** How the agent lists findings: Gloss opens a thread on each one's lines. */
const FINDINGS_FORMAT = `\`\`\`gloss-findings
[{"file": "src/orders.ts", "side": "new", "start": 42, "end": 44, "severity": "bug", "title": "One line", "body": "Why it matters and what to do."}]
\`\`\`

- file: the path relative to the repository root, as in the diff.
- side: "new" for lines of the current version, "old" for removed lines (numbered as in the base).
- start, end: the lines the finding is about, on that side. Keep the range to the lines that matter.
- severity: "bug" (wrong behavior), "suggestion" (worth changing) or "nit" (minor).

Only report lines the diff shows. Use an empty array if you find nothing.`

/** Added to Gloss's agent instructions in a review session. */
export const REVIEW_INSTRUCTIONS = `- This is a review session. Tags of the form \`[re: path:line "<quote>"]\` (or \`path:start-end\`) quote lines of the diff under review: the path is relative to the repository root, and \`(old)\` after the lines means the base's version of removed lines.
- When asked in the main conversation to review the diff or to find problems in it, list your findings in one fenced block tagged \`gloss-findings\` that holds a JSON array, after your answer:

${FINDINGS_FORMAT}`

/** The first line of the first pass, which marks that message in the log. */
export const FIRST_PASS_MARK = 'Gloss review: first pass.'

export function isFirstPass(text: string): boolean {
  return text.startsWith(FIRST_PASS_MARK)
}

/**
 * The message that starts a review: asks the agent for a summary and its findings.
 * `pr` is the pull request's number, for a review of one.
 */
export function firstPassPrompt(diff: Pick<ReviewDiff, 'baseRef' | 'base' | 'headRef' | 'head'>, pr?: number): string {
  const what =
    pr !== undefined
      ? `Review pull request #${pr}: everything on this branch since it left \`${diff.baseRef}\`, committed or not.`
      : diff.headRef === null && diff.base === diff.head
        ? 'Review the uncommitted changes in this repository: staged, unstaged and new files.'
        : isCommitId(diff.baseRef)
          ? `Review the changes since ${diff.base.slice(0, 7)}.`
          : `Review the changes on this branch: everything since it left \`${diff.baseRef}\`, committed or not.`
  return `${FIRST_PASS_MARK}
${what} Run ${diffCommand(diff)}, and read the surrounding code where you need it. Don't change any files yet.

Reply with a short summary of the change and your overall assessment, then list your findings in one fenced block tagged \`gloss-findings\` that holds a JSON array:

${FINDINGS_FORMAT}`
}

// Findings

export type RawFinding = { file: string; side: Side; start: number; end: number } & Finding

/** A `gloss-findings` block in an agent message: where it is, and what it lists. */
export type FindingsBlock = { start: number; end: number; findings: RawFinding[] }

const BLOCK = /```gloss-findings[^\n]*\n([\s\S]*?)\n?```/g

/** The findings blocks in a message. A block that isn't valid JSON lists nothing. */
export function findingsBlocks(text: string): FindingsBlock[] {
  const out: FindingsBlock[] = []
  for (const m of text.matchAll(BLOCK)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(m[1])
    } catch {
      parsed = []
    }
    const findings = (Array.isArray(parsed) ? parsed : []).map(toFinding).filter((f): f is RawFinding => f !== null)
    out.push({ start: m.index, end: m.index + m[0].length, findings })
  }
  return out
}

function toFinding(v: unknown): RawFinding | null {
  const f = v as Record<string, unknown> | null
  if (!f || typeof f.file !== 'string' || !f.file.trim()) return null
  const start = Number(f.start)
  const end = f.end === undefined ? start : Number(f.end)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null
  const severity = SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : 'suggestion'
  const title = typeof f.title === 'string' ? f.title.trim() : ''
  const body = typeof f.body === 'string' ? f.body.trim() : ''
  if (!title && !body) return null
  return {
    file: f.file.trim().replace(/^\.?\//, ''),
    side: f.side === 'old' ? 'old' : 'new',
    start,
    end,
    severity,
    title: title || body.split('\n')[0],
    body
  }
}

/** A message's text without its findings blocks (shown as a row instead). */
export function withoutFindings(text: string): string {
  return text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** The finding's thread, if the first pass opened one for it. */
export function findingThread(f: RawFinding, threads: Thread[]): Thread | undefined {
  return threads.find(
    (t) =>
      t.anchor.kind === 'line' &&
      t.finding?.title === f.title &&
      t.anchor.file === f.file &&
      t.anchor.side === f.side &&
      t.anchor.start === f.start &&
      t.anchor.end === f.end
  )
}

// Lines of the diff

/**
 * The unchanged lines before hunk `index` (index = hunks.length: after the last hunk),
 * as new-side numbers from `from` to `to` (null: to the end of the file). A line's
 * number in the base is its new number plus `delta`.
 */
export type Gap = { index: number; from: number; to: number | null; delta: number }

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

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
    const m = HUNK_HEADER.exec(h.header)
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

/** Whether the lines around a file's hunks can be shown: a text file that exists on both sides. */
export function expandable(file: DiffFile): boolean {
  return !file.binary && file.hunks.length > 0 && file.status !== 'added' && file.status !== 'deleted'
}

/**
 * One side of a file: the line numbers and text its hunks show and, given the file at
 * the reviewed commit (`source`), the unchanged lines between and around them.
 */
export function sideLines(file: DiffFile, side: Side, source?: string[] | null): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = []
  const gaps = source && expandable(file) ? gapsOf(file.hunks) : null
  const pushGap = (g: Gap | undefined): void => {
    if (!g || !source) return
    // The file may have changed since the diff was read: keep within it.
    const to = Math.min(g.to ?? source.length, source.length)
    for (let k = g.from; k <= to; k++) out.push({ n: side === 'new' ? k : k + g.delta, text: source[k - 1] })
  }
  file.hunks.forEach((h, i) => {
    pushGap(gaps?.[i])
    for (const l of h.lines) {
      const n = side === 'new' ? l.new : l.old
      if (n !== null) out.push({ n, text: l.text })
    }
  })
  pushGap(gaps?.[file.hunks.length])
  return out
}

/** The text of lines start..end on one side, if the diff (or, given it, the file around it) has all of them. */
export function linesOf(file: DiffFile, side: Side, start: number, end: number, source?: string[] | null): string[] | null {
  const byNumber = new Map(sideLines(file, side, source).map((l) => [l.n, l.text]))
  const out: string[] = []
  for (let n = start; n <= end; n++) {
    const text = byNumber.get(n)
    if (text === undefined) return null
    out.push(text)
  }
  return out
}

/** Where a line thread is in the current diff. */
export type Location =
  /** Its lines, found by their text (they may have moved). */
  | { kind: 'found'; start: number; end: number }
  /** Its lines are gone; `at` is the nearest line on its side to show it by, or null for the file's top. */
  | { kind: 'outdated'; at: number | null }
  /** Its file is no longer in the diff. */
  | { kind: 'gone' }

/**
 * Re-finds a thread's lines by their text on the same side, nearest the old position:
 * in the diff, and in the unchanged lines around it for files in `sources` (the files
 * at the reviewed commit, by path).
 */
export function locate(anchor: LineAnchor, files: DiffFile[], sources: Record<string, string[] | null> = {}): Location {
  const file = files.find((f) => f.path === anchor.file)
  if (!file) return { kind: 'gone' }
  const lines = sideLines(file, anchor.side, sources[file.path])
  const want = anchor.lines
  let best: number | null = null
  if (want.length > 0) {
    for (let i = 0; i + want.length <= lines.length; i++) {
      let ok = true
      for (let k = 0; k < want.length && ok; k++) {
        ok = lines[i + k].text === want[k] && (k === 0 || lines[i + k].n === lines[i + k - 1].n + 1)
      }
      if (ok && (best === null || Math.abs(lines[i].n - anchor.start) < Math.abs(lines[best].n - anchor.start))) best = i
    }
  }
  if (best !== null) return { kind: 'found', start: lines[best].n, end: lines[best].n + want.length - 1 }
  let near: number | null = null
  for (const l of lines) {
    if (near === null || Math.abs(l.n - anchor.start) < Math.abs(near - anchor.start)) near = l.n
  }
  return { kind: 'outdated', at: near }
}

/**
 * Where a line on one side is in the file at the reviewed commit, to open it there: a
 * removed line opens where it was, at the line that now follows it.
 */
export function newLineOf(file: DiffFile, side: Side, n: number): number {
  if (side === 'new') return n
  for (const h of file.hunks) {
    const i = h.lines.findIndex((l) => l.old === n)
    if (i < 0) continue
    const at = h.lines[i].new ?? h.lines.slice(i).find((l) => l.new !== null)?.new
    if (at !== undefined && at !== null) return at
    // Removed at the end of the hunk: the line after the hunk's last line now.
    const before = h.lines.slice(0, i).findLast((l) => l.new !== null)?.new
    if (before !== undefined && before !== null) return before + 1
    const m = HUNK_HEADER.exec(h.header)
    return m ? span(m[3], m[4]).first : n
  }
  // An unchanged line outside the hunks moves by the lines added and removed before it.
  const gap = gapsOf(file.hunks)?.find((g) => n - g.delta >= g.from && (g.to === null || n - g.delta <= g.to))
  return Math.max(1, gap ? n - gap.delta : n)
}

/** `src/a.ts:12` or `src/a.ts:12-14`, with ` (old)` for the base's side. */
export function lineLabel(anchor: Pick<LineAnchor, 'file' | 'side' | 'start' | 'end'>): string {
  const range = anchor.start === anchor.end ? `${anchor.start}` : `${anchor.start}-${anchor.end}`
  return `${anchor.file}:${range}${anchor.side === 'old' ? ' (old)' : ''}`
}

/** The language Shiki knows a file by, from its extension. */
export function languageOf(path: string): string | null {
  const name = path.split('/').pop() ?? ''
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return LANGUAGES[ext] ?? (ext || null)
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  rs: 'rust',
  rb: 'ruby',
  cs: 'csharp',
  kt: 'kotlin',
  h: 'c',
  hpp: 'cpp',
  cc: 'cpp',
  htm: 'html'
}
