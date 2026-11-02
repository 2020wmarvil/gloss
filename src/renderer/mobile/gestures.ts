// Touch and timing helpers for the phone client (SPEC → Remote and mobile).
import { useEffect, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'

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

/** A swipe past this share of the screen, or a quick flick, goes back or forward. */
const COMMIT = 0.35
const FLICK = 0.5 // px per ms
/** How far a move goes before it counts as sideways or as a scroll. */
const SLOP = 10
const SETTLE_MS = 200
/** How far the screen beneath sits to the left (a share of the width), and how dim. */
const PARALLAX = 0.3
const DIM = 0.12

export type Swipe = 'back' | 'forward'

/**
 * Sideways swipes anywhere on the page, as iOS: a swipe right drags the `top` screen off to the
 * right, uncovering the one it goes `back` to (`under`); a swipe left drags the screen it goes
 * `forward` to (`over`) in from the right, over the top one. `onPeek` shows that other screen while
 * the swipe lasts. Let go far enough (or flick) and the move completes; otherwise it springs back.
 * A swipe doesn't start in a field, a sheet or the image viewer, on something that scrolls sideways
 * (code, tool output, thumbnails), or while text is selected; a move that starts vertical is a scroll.
 */
export function useSwipeNav(opts: {
  back: (() => void) | null
  forward: (() => void) | null
  top: RefObject<HTMLElement | null>
  under: RefObject<HTMLElement | null>
  over: RefObject<HTMLElement | null>
  onPeek(swipe: Swipe | null): void
}): void {
  const current = useRef(opts)
  current.current = opts
  useEffect(() => {
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    let start: { x: number; y: number } | null = null
    let swipe: Swipe | null = null
    let last = { x: 0, t: 0, v: 0 }
    let busy = false

    const place = (el: HTMLElement | null, x: number, dim: number, transition: string, shadow = false): void => {
      if (!el) return
      el.style.transition = transition
      el.style.transform = `translateX(${x}px)`
      el.style.boxShadow = shadow ? 'var(--shadow-3)' : ''
      const veil = el.querySelector<HTMLElement>(':scope > .m-layer-dim')
      if (veil) {
        veil.style.transition = transition
        veil.style.opacity = String(dim)
      }
    }
    /** Lays the screens out for a finger `d` px along the swipe (0 to the screen's width). */
    const set = (d: number, ms = 0): void => {
      const { top, under, over } = current.current
      const width = window.innerWidth
      const transition = ms && !still ? `transform ${ms}ms ease-out, opacity ${ms}ms ease-out` : 'none'
      if (swipe === 'back') {
        place(top.current, d, 0, transition, d > 0)
        place(under.current, -PARALLAX * (width - d), DIM * (1 - d / width), transition)
      } else {
        place(over.current, width - d, 0, transition, true)
        place(top.current, -PARALLAX * d, DIM * (d / width), transition)
      }
    }
    const after = (ms: number, then: () => void): void => void setTimeout(then, still ? 0 : ms)
    /** Ends the swipe: `move` (if any) runs in the same frame the copy goes and the top screen settles. */
    const finish = (move?: () => void): void => {
      flushSync(() => {
        move?.()
        current.current.onPeek(null)
      })
      const top = current.current.top.current
      place(top, 0, 0, '')
      // Idle, the top screen has no transform (one would contain its fixed-position parts).
      if (top) top.style.transform = ''
      swipe = null
      busy = false
    }

    const onStart = (e: TouchEvent): void => {
      const target = e.target instanceof Element ? e.target : null
      const { back, forward } = current.current
      start = !busy && swipe === null && e.touches.length === 1 && (back || forward) && target && !excluded(target)
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : null
    }
    const onMove = (e: TouchEvent): void => {
      if (!start) return
      const t = e.touches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      if (!swipe) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
        const selection = window.getSelection()
        const dir: Swipe = dx > 0 ? 'back' : 'forward'
        if (Math.abs(dy) > Math.abs(dx) || !current.current[dir] || (selection && !selection.isCollapsed)) {
          start = null
          return
        }
        swipe = dir
        busy = true
        start = { x: t.clientX, y: t.clientY }
        last = { x: t.clientX, t: e.timeStamp, v: 0 }
        // The other screen renders now, so the first frame of the drag already shows it.
        flushSync(() => current.current.onPeek(dir))
      }
      e.preventDefault()
      const dt = e.timeStamp - last.t
      if (dt > 0) last = { x: t.clientX, t: e.timeStamp, v: (t.clientX - last.x) / dt }
      set(Math.max(0, (t.clientX - start.x) * (swipe === 'back' ? 1 : -1)))
    }
    const springBack = (): void => {
      set(0, SETTLE_MS)
      after(SETTLE_MS, () => finish())
    }
    const onEnd = (e: TouchEvent): void => {
      const from = start
      start = null
      if (!from || !swipe) return
      const sign = swipe === 'back' ? 1 : -1
      const width = window.innerWidth
      const d = Math.max(0, ((e.changedTouches[0]?.clientX ?? from.x) - from.x) * sign)
      const move = current.current[swipe]
      if (!move || (d < width * COMMIT && last.v * sign < FLICK)) return springBack()
      set(width, SETTLE_MS)
      after(SETTLE_MS, () => finish(move))
    }
    const onCancel = (): void => {
      const was = start
      start = null
      if (was && swipe) springBack()
    }
    document.addEventListener('touchstart', onStart, { passive: true })
    // Not passive: a sideways drag stops the page scrolling under it.
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onCancel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
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
