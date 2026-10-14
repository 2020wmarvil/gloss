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

export type ReviewDiff = {
  /** The branch reviewed against, e.g. "origin/main". */
  baseRef: string
  /** The merge base of HEAD and baseRef. */
  base: string
  files: DiffFile[]
}

export const SEVERITIES: Severity[] = ['bug', 'suggestion', 'nit']

/** Files with more changed lines than this start collapsed. */
export const LARGE_FILE_LINES = 1000

// Agent instructions and the first pass

/** Added to Gloss's agent instructions in a review session. */
export const REVIEW_INSTRUCTIONS = `- This is a review session. Tags of the form \`[re: path:line "<quote>"]\` (or \`path:start-end\`) quote lines of the diff under review: the path is relative to the repository root, and \`(old)\` after the lines means the base's version of removed lines.`

/** The first line of the first pass, which marks that message in the log. */
export const FIRST_PASS_MARK = 'Gloss review: first pass.'

export function isFirstPass(text: string): boolean {
  return text.startsWith(FIRST_PASS_MARK)
}

/** The message that starts a review: asks the agent for a summary and its findings. */
export function firstPassPrompt(baseRef: string, base: string): string {
  return `${FIRST_PASS_MARK}
Review the changes on this branch: everything since it left \`${baseRef}\`, committed or not. Run \`git diff ${base}\` (it includes uncommitted changes) and \`git ls-files --others --exclude-standard\` for new files, and read the surrounding code where you need it. Don't change any files yet.

Reply with a short summary of the change and your overall assessment, then list your findings in one fenced block tagged \`gloss-findings\` that holds a JSON array:

\`\`\`gloss-findings
[{"file": "src/orders.ts", "side": "new", "start": 42, "end": 44, "severity": "bug", "title": "One line", "body": "Why it matters and what to do."}]
\`\`\`

- file: the path relative to the repository root, as in the diff.
- side: "new" for lines of the current version, "old" for removed lines (numbered as in the base).
- start, end: the lines the finding is about, on that side. Keep the range to the lines that matter.
- severity: "bug" (wrong behavior), "suggestion" (worth changing) or "nit" (minor).

Only report lines the diff shows. Use an empty array if you find nothing.`
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

/** One side of a file as shown in the diff: line numbers and their text. */
export function sideLines(file: DiffFile, side: Side): { n: number; text: string }[] {
  const out: { n: number; text: string }[] = []
  for (const h of file.hunks) {
    for (const l of h.lines) {
      const n = side === 'new' ? l.new : l.old
      if (n !== null) out.push({ n, text: l.text })
    }
  }
  return out
}

/** The text of lines start..end on one side, if the diff shows all of them. */
export function linesOf(file: DiffFile, side: Side, start: number, end: number): string[] | null {
  const byNumber = new Map(sideLines(file, side).map((l) => [l.n, l.text]))
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

/** Re-finds a thread's lines by their text on the same side, nearest the old position. */
export function locate(anchor: LineAnchor, files: DiffFile[]): Location {
  const file = files.find((f) => f.path === anchor.file)
  if (!file) return { kind: 'gone' }
  const lines = sideLines(file, anchor.side)
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
