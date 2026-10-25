// Scroll positions carried with a session to another window (SPEC → Session windows).
// A position is the block at the top of the view (a paragraph of a message, a line of the
// diff) and how far it is scrolled past, not pixels: the other window has another width,
// so text wraps differently.
import { useEffect, useLayoutEffect, type RefObject } from 'react'

export type ScrollSpot = { bottom: true } | { id: string; block?: string; offset: number }

/** How a scroller's content is found: items named by `attr`, and the blocks inside them. */
export type ScrollAnchors = {
  /** The items (messages, files), each named by `attr`. */
  item: string
  attr: string
  /** Blocks inside an item, for a finer position. */
  block: string
  /** A block's name; by default its position among the item's blocks. */
  blockKey?(block: HTMLElement, index: number): string
}

/** Mounted scrollers by key, each able to say where it is. Keys start with their session's id. */
const live = new Map<string, () => ScrollSpot | null>()
/** Positions brought from another window, for the scrollers that mount next. */
const pending = new Map<string, ScrollSpot>()

/** Where a session's scrollers are now. */
export function sessionScrolls(sessionId: string): Record<string, ScrollSpot> {
  const out: Record<string, ScrollSpot> = {}
  for (const [key, where] of live) {
    const spot = key.startsWith(sessionId) ? where() : null
    if (spot) out[key] = spot
  }
  return out
}

/** A session's positions from another window, replacing any left from before. */
export function restoreScrolls(sessionId: string, from: Record<string, ScrollSpot>): void {
  for (const key of [...pending.keys()]) if (key.startsWith(sessionId)) pending.delete(key)
  for (const [key, spot] of Object.entries(from)) pending.set(key, spot)
}

/** Restoring stops once the user scrolls, or this long after the target shows. */
const SETTLE_MS = 1500

function blockKey(anchors: ScrollAnchors, block: HTMLElement, index: number): string {
  return anchors.blockKey ? anchors.blockKey(block, index) : String(index)
}

/** The element at the top of the view: the first that reaches below it, and the deepest such block inside it. */
function topOf(el: HTMLElement, anchors: ScrollAnchors): { item: HTMLElement; block?: HTMLElement; index: number } | null {
  const top = el.getBoundingClientRect().top
  const item = [...el.querySelectorAll<HTMLElement>(anchors.item)].find((i) => i.getAttribute(anchors.attr) !== null && i.getBoundingClientRect().bottom > top)
  if (!item) return null
  let found: { block: HTMLElement; index: number } | undefined
  const blocks = [...item.querySelectorAll<HTMLElement>(anchors.block)]
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.getBoundingClientRect().bottom <= top) continue
    // A block inside the one found is a finer position; any other comes after it.
    if (found && !found.block.contains(b)) break
    found = { block: b, index: i }
  }
  return { item, ...found, index: found?.index ?? -1 }
}

/**
 * Remembers where `ref`'s scroller is and restores a position brought from another window
 * when it mounts: while its content loads and lays out, until the user scrolls.
 * `onRestore` runs when a position other than the bottom is restored (a log stops
 * sticking to the bottom).
 */
export function useScrollMemory(
  ref: RefObject<HTMLElement | null>,
  key: string | undefined,
  anchors: ScrollAnchors,
  onRestore?: () => void
): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !key) return
    const where = (): ScrollSpot | null => {
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) return { bottom: true }
      const at = topOf(el, anchors)
      if (!at) return null
      const target = at.block ?? at.item
      const offset = el.getBoundingClientRect().top - target.getBoundingClientRect().top
      return { id: at.item.getAttribute(anchors.attr)!, ...(at.block ? { block: blockKey(anchors, at.block, at.index) } : {}), offset }
    }
    live.set(key, where)
    return () => {
      if (live.get(key) === where) live.delete(key)
    }
    // The anchors are constant for a scroller.
  }, [ref, key])

  useLayoutEffect(() => {
    const el = ref.current
    const spot = key ? pending.get(key) : undefined
    if (!el || !key || !spot) return
    pending.delete(key)
    if (!('id' in spot)) {
      el.scrollTop = el.scrollHeight
      return
    }
    onRestore?.()
    let settleAt = Infinity
    const find = (): HTMLElement | undefined => {
      const item = [...el.querySelectorAll<HTMLElement>(anchors.item)].find((i) => i.getAttribute(anchors.attr) === spot.id)
      if (!item || spot.block === undefined) return item
      const blocks = [...item.querySelectorAll<HTMLElement>(anchors.block)]
      return blocks.find((b, i) => blockKey(anchors, b, i) === spot.block) ?? item
    }
    const apply = (): void => {
      const target = find()
      if (!target) return
      if (settleAt === Infinity) settleAt = Date.now() + SETTLE_MS
      el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top + spot.offset
    }
    const stop = (): void => {
      observer?.disconnect()
      mutations.disconnect()
      el.removeEventListener('wheel', stop)
      el.removeEventListener('pointerdown', stop)
      el.removeEventListener('keydown', stop)
    }
    const again = (): void => (Date.now() < settleAt ? apply() : stop())
    // Content arrives and grows (the diff loads, code highlights, images load): keep the spot in view.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(again)
    const content = el.firstElementChild
    if (observer && content) observer.observe(content)
    const mutations = new MutationObserver(again)
    mutations.observe(el, { childList: true, subtree: true })
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('pointerdown', stop)
    el.addEventListener('keydown', stop)
    apply()
    return stop
    // Restores once, when the scroller mounts.
  }, [key])
}
