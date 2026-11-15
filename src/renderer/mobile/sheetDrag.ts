// Swipe a bottom sheet down to close it, as on iOS. The sheet follows the finger once a touch
// moves down from a list that is scrolled to its top; let go past a third of its height (or
// flick) and it slides off, otherwise it springs back. Its dim fades with it.
import { useCallback, useRef } from 'react'

/** A touch that moves further than this decides whether it drags the sheet. */
const SLOP = 8
/** Downward speed (px/ms) that closes the sheet whatever the distance. */
const FLICK = 0.5

/** The nearest scrolling box between the touched element and the sheet, the sheet included. */
function scroller(from: EventTarget | null, sheet: HTMLElement): HTMLElement {
  for (let el = from instanceof Element ? from : null; el && el !== sheet; el = el.parentElement) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el
  }
  return sheet
}

/**
 * Pass the returned callback as the sheet's `ref` (`.m-sheet`, with its `.m-dim` just before it).
 * `closable` false (a sheet busy creating or deleting) leaves it where it is.
 */
export function useSheetDrag<T extends HTMLElement>(onClose: () => void, closable = true): (sheet: T | null) => void {
  const close = useRef(onClose)
  close.current = onClose
  const allowed = useRef(closable)
  allowed.current = closable
  const detach = useRef<(() => void) | null>(null)

  return useCallback((sheet: T | null) => {
    detach.current?.()
    detach.current = null
    if (!sheet) return
    const dim = sheet.previousElementSibling instanceof HTMLElement && sheet.previousElementSibling.classList.contains('m-dim')
      ? sheet.previousElementSibling : null
    let start: { x: number; y: number; t: number; top: boolean } | null = null
    let dragging = false
    let last = { y: 0, t: 0 }
    let speed = 0

    const place = (dy: number, animate: boolean): void => {
      const ease = animate ? 'transform 0.22s ease-out' : ''
      sheet.style.transition = ease
      sheet.style.transform = dy ? `translateY(${dy}px)` : ''
      if (dim) {
        dim.style.transition = animate ? 'opacity 0.22s ease-out' : ''
        dim.style.opacity = dy ? String(Math.max(0, 1 - dy / sheet.offsetHeight)) : ''
      }
    }
    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || !allowed.current) { start = null; return }
      const t = e.touches[0]
      start = { x: t.clientX, y: t.clientY, t: e.timeStamp, top: scroller(e.target, sheet).scrollTop <= 0 }
      dragging = false
      last = { y: t.clientY, t: e.timeStamp }
      speed = 0
    }
    const onMove = (e: TouchEvent): void => {
      if (!start || e.touches.length !== 1) return
      const t = e.touches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      if (!dragging) {
        if (Math.hypot(dx, dy) < SLOP) return
        // Only a mostly vertical move down, from a list already at its top, takes the sheet.
        if (!start.top || dy <= 0 || Math.abs(dy) < Math.abs(dx)) { start = null; return }
        dragging = true
        ;(document.activeElement as HTMLElement | null)?.blur?.()
      }
      e.preventDefault()
      const dt = e.timeStamp - last.t
      if (dt > 0) speed = (t.clientY - last.y) / dt
      last = { y: t.clientY, t: e.timeStamp }
      place(Math.max(0, dy), false)
    }
    const onEnd = (e: TouchEvent): void => {
      if (!start || !dragging) { start = null; return }
      const dy = Math.max(0, last.y - start.y)
      start = null
      dragging = false
      if (e.type !== 'touchcancel' && (dy > sheet.offsetHeight / 3 || speed > FLICK)) {
        place(sheet.offsetHeight, true)
        setTimeout(() => close.current(), 200)
      } else place(0, true)
    }
    sheet.addEventListener('touchstart', onStart, { passive: true })
    sheet.addEventListener('touchmove', onMove, { passive: false })
    sheet.addEventListener('touchend', onEnd)
    sheet.addEventListener('touchcancel', onEnd)
    detach.current = () => {
      sheet.removeEventListener('touchstart', onStart)
      sheet.removeEventListener('touchmove', onMove)
      sheet.removeEventListener('touchend', onEnd)
      sheet.removeEventListener('touchcancel', onEnd)
    }
  }, [])
}
