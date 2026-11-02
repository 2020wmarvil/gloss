// Touch and timing helpers for the phone client (SPEC → Remote and mobile).
import { useEffect, useRef, useState } from 'react'

/** `value`, but a change to `true` shows only once it has held for `ms`; a change to `false` shows at once. */
export function useSettled(value: boolean, ms: number): boolean {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (!value) {
      setSettled(false)
      return
    }
    const t = setTimeout(() => setSettled(true), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}

/** A swipe right this far, mostly sideways, goes back. */
const SWIPE = 80

/**
 * Calls `back` on a swipe right anywhere on the page, except one that starts in a field, a sheet
 * or the image viewer, scrolls something sideways (code, tool output, thumbnails), or selects text.
 */
export function useSwipeBack(back: (() => void) | null): void {
  const current = useRef(back)
  current.current = back
  useEffect(() => {
    let start: { x: number; y: number } | null = null
    const onStart = (e: TouchEvent): void => {
      const target = e.target instanceof Element ? e.target : null
      start = e.touches.length === 1 && current.current && target && !excluded(target)
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : null
    }
    const onEnd = (e: TouchEvent): void => {
      const from = start
      start = null
      const t = e.changedTouches[0]
      if (!from || !t) return
      const dx = t.clientX - from.x
      const dy = Math.abs(t.clientY - from.y)
      const selection = window.getSelection()
      if (dx < SWIPE || dy > dx / 2 || (selection && !selection.isCollapsed)) return
      current.current?.()
    }
    const onCancel = (): void => { start = null }
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onCancel)
    }
  }, [])
}

function excluded(target: Element): boolean {
  if (target.closest('input, textarea, select, [contenteditable="true"], .m-sheet, .m-dim, .m-lightbox')) return true
  for (let el: Element | null = target; el; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true
  }
  return false
}
