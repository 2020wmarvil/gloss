// Right-button line selection: pressing the right button selects the line under the
// pointer, dragging extends the selection over every line passed, and releasing opens
// the selection's context menu. Pressing on the selection itself keeps it.
import { useEffect, useRef, type RefObject } from 'react'

export type Point = { node: Node; offset: number }
/** A line's bounds; `el` is what the caller uses to keep a drag on the line's message or side. */
export type LineBounds = { start: Point; end: Point; el: HTMLElement }

/** Is point a at or before point b? */
function atOrBefore(a: Point, b: Point): boolean {
  const r = document.createRange()
  r.setStart(a.node, a.offset)
  r.collapse(true)
  return r.comparePoint(b.node, b.offset) >= 0
}

/** Is (x, y) over the selection's text? */
export function overSelection(x: number, y: number): boolean {
  const s = window.getSelection()
  if (!s || s.isCollapsed || s.rangeCount === 0) return false
  return [...s.getRangeAt(0).getClientRects()].some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)
}

/** The visual (wrapped) line of text at (x, y) inside `root`, using the live selection to find its ends. */
export function visualLineAt(x: number, y: number, root: (node: Node) => HTMLElement | null): LineBounds | null {
  const caret = document.caretRangeFromPoint?.(x, y)
  const s = window.getSelection()
  if (!caret || !s) return null
  const el = root(caret.startContainer)
  if (!el) return null
  const at = (direction: 'backward' | 'forward'): Point | null => {
    s.collapse(caret.startContainer, caret.startOffset)
    s.modify('move', direction, 'lineboundary')
    return s.focusNode ? { node: s.focusNode, offset: s.focusOffset } : null
  }
  const start = at('backward')
  const end = at('forward')
  return start && end ? { start, end, el } : null
}

type Options = {
  scope: RefObject<HTMLElement | null>
  /** The line at (x, y); during a drag `first` is the line it started on. */
  lineAt(x: number, y: number, first: LineBounds | null): LineBounds | null
  /** Open the menu on the selection; `first` is the line a new selection started on (null when it was kept). */
  onMenu(x: number, y: number, first: LineBounds | null): void
}

export function useRightButtonLines({ scope, lineAt, onMenu }: Options): void {
  const latest = useRef({ lineAt, onMenu })
  latest.current = { lineAt, onMenu }

  useEffect(() => {
    /**
     * The press in progress: the line it started on, or null when it kept the selection.
     * A press on the selection keeps it until the pointer leaves the line pressed on (`on`).
     */
    let press: { first: LineBounds | null; on?: LineBounds } | null = null
    const select = (a: LineBounds, b: LineBounds): void => {
      const [from, to] = atOrBefore(a.start, b.start) ? [a, b] : [b, a]
      window.getSelection()?.setBaseAndExtent(from.start.node, from.start.offset, to.end.node, to.end.offset)
    }
    const inScope = (e: MouseEvent): boolean => e.target instanceof Node && scope.current?.contains(e.target) === true

    const onDown = (e: MouseEvent): void => {
      press = null
      if (e.button !== 2 || !inScope(e)) return
      if (overSelection(e.clientX, e.clientY)) {
        // Finding the line moves the selection, so it is put back.
        const s = window.getSelection()
        const kept = s?.getRangeAt(0).cloneRange()
        const on = latest.current.lineAt(e.clientX, e.clientY, null) ?? undefined
        if (s && kept) {
          s.removeAllRanges()
          s.addRange(kept)
        }
        e.preventDefault()
        press = { first: null, on }
        return
      }
      const line = latest.current.lineAt(e.clientX, e.clientY, null)
      if (!line) {
        window.getSelection()?.removeAllRanges()
        return
      }
      // Chromium's own right-press handling would move or drop the selection.
      e.preventDefault()
      select(line, line)
      press = { first: line }
    }
    const onMove = (e: MouseEvent): void => {
      if (!press || (!press.first && !press.on)) return
      if ((e.buttons & 2) === 0) {
        press = null
        return
      }
      const first = press.first ?? press.on!
      const line = latest.current.lineAt(e.clientX, e.clientY, first)
      if (!line) return
      if (!press.first && line.start.node === first.start.node && line.start.offset === first.start.offset) return
      press.first = first
      select(first, line)
    }
    const onUp = (e: MouseEvent): void => {
      if (e.button !== 2 || !press) return
      const { first } = press
      press = null
      latest.current.onMenu(e.clientX, e.clientY, first)
    }
    // The menu opens on release (contextmenu comes on press on macOS), so the native event is only suppressed.
    const onContextMenu = (e: MouseEvent): void => {
      if (inScope(e)) e.preventDefault()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('contextmenu', onContextMenu)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('contextmenu', onContextMenu)
    }
  }, [scope])
}
