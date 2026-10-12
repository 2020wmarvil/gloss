// Maps a DOM selection inside a rendered agent message to source offsets,
// using the data-src spans emitted by remarkSourceSpans.
import { align } from './source'

/** Is point a at or before point b? */
function atOrBefore(doc: Document, aNode: Node, aOffset: number, bNode: Node, bOffset: number): boolean {
  const r = doc.createRange()
  r.setStart(aNode, aOffset)
  r.collapse(true)
  return r.comparePoint(bNode, bOffset) >= 0
}

function srcStart(seg: HTMLElement): number {
  return Number(seg.dataset.src)
}

function srcEnd(seg: HTMLElement): number {
  return Number(seg.dataset.srcEnd)
}

/** A boundary point inside a segment, as a source offset. */
function within(seg: HTMLElement, k: number, edge: 'start' | 'end', markdown: string): number {
  const text = seg.textContent ?? ''
  const S = srcStart(seg)
  const map = align(text, markdown.slice(S, srcEnd(seg)))
  return edge === 'start' ? S + map[k] : S + map[k - 1] + 1
}

function boundary(
  segs: HTMLElement[],
  node: Node,
  offset: number,
  edge: 'start' | 'end',
  markdown: string
): number | null {
  const i = segs.findIndex((s) => s.contains(node))
  if (i !== -1) {
    const seg = segs[i]
    const r = seg.ownerDocument.createRange()
    r.setStart(seg, 0)
    r.setEnd(node, offset)
    const k = r.toString().length
    const length = (seg.textContent ?? '').length
    // A start at a segment's end begins in the next segment; an end at a
    // segment's start ends in the previous one. Otherwise markup between
    // them (a backtick, "**") would be included.
    if (edge === 'start' && k >= length) return i + 1 < segs.length ? srcStart(segs[i + 1]) : null
    if (edge === 'end' && k === 0) return i > 0 ? srcEnd(segs[i - 1]) : null
    return within(seg, k, edge, markdown)
  }
  // The point is outside any text (a list marker, a button): snap to the
  // nearest text inside the selection.
  const doc = segs[0].ownerDocument
  if (edge === 'start') {
    const next = segs.find((s) => atOrBefore(doc, node, offset, s, 0))
    return next ? srcStart(next) : null
  }
  const prev = [...segs].reverse().find((s) => atOrBefore(doc, s, s.childNodes.length, node, offset))
  return prev ? srcEnd(prev) : null
}

/** The source range [start, end) a DOM range covers inside `root`, or null if it covers no text. */
export function rangeToSource(root: Element, range: Range, markdown: string): { start: number; end: number } | null {
  const segs = Array.from(root.querySelectorAll<HTMLElement>('[data-src]'))
  if (segs.length === 0) return null
  const start = boundary(segs, range.startContainer, range.startOffset, 'start', markdown)
  const end = boundary(segs, range.endContainer, range.endOffset, 'end', markdown)
  if (start === null || end === null || start >= end) return null
  return { start, end }
}
