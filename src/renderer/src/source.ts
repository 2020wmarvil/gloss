// Maps between an agent message's rendered text and its source markdown.
// Selection anchors are stored as source offsets (SPEC → Anchors); these
// functions turn offsets into the text a reader sees and find stored text again.
import type { Nodes } from 'mdast'
import { parseMarkdown } from './anchors'

/** One run of rendered text (a text, inline code, code block or raw HTML node). */
export type TextRun = {
  value: string
  /** Absolute source offset of each character of `value`. */
  offsets: number[]
}

const TEXT_TYPES = new Set(['text', 'inlineCode', 'code', 'html'])

/** A fenced code block's content starts after the opening fence line. */
export function isFenced(source: string): boolean {
  return /^[ \t]*(```|~~~)/.test(source)
}

/**
 * Aligns a node's rendered value to its source slice: offsets[i] is the index
 * in `source` of value[i]. The source is a superset of the value (it adds
 * markup, escapes, indentation, quote markers), so a greedy forward match
 * works; a character with no match keeps the current position.
 */
export function align(value: string, source: string, skipFirstLine = false): number[] {
  const offsets = new Array<number>(value.length)
  let p = 0
  if (skipFirstLine) {
    const nl = source.indexOf('\n')
    p = nl === -1 ? source.length : nl + 1
  }
  for (let i = 0; i < value.length; i++) {
    let q = p
    while (q < source.length && source[q] !== value[i]) q++
    if (q < source.length) {
      offsets[i] = q
      p = q + 1
    } else {
      offsets[i] = Math.min(p, Math.max(0, source.length - 1))
    }
  }
  return offsets
}

/** Absolute source offsets for a text-bearing mdast node's value. */
export function nodeOffsets(markdown: string, node: { type: string; value: string; position?: Nodes['position'] }): number[] | null {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined || node.value.length === 0) return null
  const local = markdown.slice(start, end)
  return align(node.value, local, node.type === 'code' && isFenced(local)).map((o) => start + o)
}

const runCache = new Map<string, TextRun[]>()

/** The message's rendered text runs, in document order. */
export function textRuns(markdown: string): TextRun[] {
  const cached = runCache.get(markdown)
  if (cached) return cached
  const runs: TextRun[] = []
  const walk = (node: Nodes): void => {
    if (TEXT_TYPES.has(node.type) && 'value' in node) {
      const offsets = nodeOffsets(markdown, node)
      if (offsets) runs.push({ value: node.value, offsets })
      return
    }
    if ('children' in node) for (const child of node.children) walk(child as Nodes)
  }
  walk(parseMarkdown(markdown))
  if (runCache.size >= 200) runCache.delete(runCache.keys().next().value!)
  runCache.set(markdown, runs)
  return runs
}

export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

type Flat = { text: string; offsets: number[] }

/**
 * The rendered text as one string with a source offset per character. Runs in
 * different blocks (a newline between them in the source) are joined by a space.
 */
function flatten(markdown: string, from = 0, to = Infinity): Flat {
  let text = ''
  const offsets: number[] = []
  let last = -1
  for (const run of textRuns(markdown)) {
    let first = true
    for (let i = 0; i < run.value.length; i++) {
      const o = run.offsets[i]
      if (o < from || o >= to) continue
      if (first && last !== -1 && markdown.slice(last + 1, o).includes('\n')) {
        text += ' '
        offsets.push(o)
      }
      first = false
      text += run.value[i]
      offsets.push(o)
      last = o
    }
  }
  return { text, offsets }
}

/** What a reader sees for the source range [start, end), whitespace collapsed. */
export function renderedText(markdown: string, start: number, end: number): string {
  return normalizeSpace(flatten(markdown, start, end).text)
}

/**
 * Finds `text` (whitespace-insensitive) in the rendered message and returns its
 * source range. With several matches, the one nearest `near` wins.
 */
export function findText(markdown: string, text: string, near = 0): { start: number; end: number } | null {
  const needle = normalizeSpace(text)
  if (!needle) return null
  const flat = flatten(markdown)
  // Collapse whitespace while keeping each kept character's source offset.
  let hay = ''
  const offs: number[] = []
  for (let i = 0; i < flat.text.length; i++) {
    const ws = /\s/.test(flat.text[i])
    if (ws && (hay.length === 0 || hay.endsWith(' '))) continue
    hay += ws ? ' ' : flat.text[i]
    offs.push(flat.offsets[i])
  }
  let best: { start: number; end: number } | null = null
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const candidate = { start: offs[i], end: offs[i + needle.length - 1] + 1 }
    if (!best || Math.abs(candidate.start - near) < Math.abs(best.start - near)) best = candidate
  }
  return best
}

/**
 * Where a selection anchor is in the message now: its stored offsets if they
 * still show its text, otherwise wherever its text is found. null if gone.
 */
export function resolveSelection(
  markdown: string,
  anchor: { start: number; end: number; text: string }
): { start: number; end: number } | null {
  const { start, end, text } = anchor
  if (start >= 0 && end <= markdown.length && start < end) {
    if (renderedText(markdown, start, end) === normalizeSpace(text)) return { start, end }
  }
  return findText(markdown, text, start)
}
