// A sent image full screen. The phone app can't zoom (mobile.html, mobile.css), so the viewer
// zooms the image itself: pinch, drag while zoomed, double tap to zoom in at a spot or back out.
// A single tap closes it.
import { useEffect, useRef } from 'react'

export type View = { s: number; x: number; y: number }
/** The image's laid-out box at scale 1 and the viewer's size, in the viewer's pixels. */
export type Frame = { left: number; top: number; w: number; h: number; vw: number; vh: number }

const MAX_SCALE = 5
const DOUBLE_TAP_SCALE = 2.5
const DOUBLE_TAP_MS = 250
/** A touch that moves further than this is a drag, not a tap. */
const TAP_SLOP = 8

function axis(t: number, s: number, start: number, size: number, screen: number): number {
  const scaled = size * s
  // Smaller than the screen: centered. Larger: no gap at either edge.
  if (scaled <= screen) return (screen - scaled) / 2 - start
  return Math.min(-start, Math.max(screen - scaled - start, t))
}

/** `v` held to the allowed scales, with the image kept over the screen. */
export function clampView(v: View, f: Frame): View {
  const s = Math.min(MAX_SCALE, Math.max(1, v.s))
  return { s, x: axis(v.x, s, f.left, f.w, f.vw), y: axis(v.y, s, f.top, f.h, f.vh) }
}

/** `from` scaled to `s` so the image point under `at` (a point on the viewer) stays under `to`. */
export function zoomAbout(from: View, s: number, at: { x: number; y: number }, to: { x: number; y: number }, f: Frame): View {
  const lx = (at.x - f.left - from.x) / from.s
  const ly = (at.y - f.top - from.y) / from.s
  return { s, x: to.x - f.left - s * lx, y: to.y - f.top - s * ly }
}

/** Where a double tap at `at` takes the view: in to 2.5x there, or back out. */
export function doubleTapView(v: View, at: { x: number; y: number }, f: Frame): View {
  if (v.s > 1) return { s: 1, x: 0, y: 0 }
  return clampView(zoomAbout(v, DOUBLE_TAP_SCALE, at, at, f), f)
}

const IDENTITY: View = { s: 1, x: 0, y: 0 }

type Gesture =
  | { kind: 'pan'; start: View; x: number; y: number }
  | { kind: 'pinch'; start: View; mid: { x: number; y: number }; dist: number }

export function Lightbox({ src, onClose }: { src: string; onClose(): void }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const el = box.current!
    const image = img.current!
    let view = IDENTITY
    let gesture: Gesture | null = null
    // Set when a touch dragged or pinched, so the click that follows isn't a tap.
    let moved = false
    let tapTimer: ReturnType<typeof setTimeout> | undefined

    const frame = (): Frame => ({
      left: image.offsetLeft, top: image.offsetTop, w: image.offsetWidth, h: image.offsetHeight,
      vw: el.clientWidth, vh: el.clientHeight
    })
    const show = (v: View, animate: boolean): void => {
      view = v
      image.style.transition = animate ? 'transform 0.2s ease-out' : ''
      image.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.s})`
    }
    const point = (t: Touch): { x: number; y: number } => {
      const r = el.getBoundingClientRect()
      return { x: t.clientX - r.left, y: t.clientY - r.top }
    }
    const begin = (touches: TouchList): void => {
      if (touches.length >= 2) {
        const a = point(touches[0])
        const b = point(touches[1])
        gesture = { kind: 'pinch', start: view, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 }
      } else if (touches.length === 1) {
        const p = point(touches[0])
        gesture = { kind: 'pan', start: view, x: p.x, y: p.y }
      } else gesture = null
    }

    const onStart = (e: TouchEvent): void => {
      if (e.touches.length === 1) moved = false
      if (e.touches.length >= 2) moved = true
      begin(e.touches)
    }
    const onMove = (e: TouchEvent): void => {
      e.preventDefault()
      if (!gesture) return
      const f = frame()
      if (gesture.kind === 'pinch' && e.touches.length >= 2) {
        const a = point(e.touches[0])
        const b = point(e.touches[1])
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        // Past the limits while the fingers are down it eases, then settles when they lift.
        const s = Math.min(MAX_SCALE * 1.2, Math.max(0.6, (gesture.start.s * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.dist))
        show(zoomAbout(gesture.start, s, gesture.mid, mid, f), false)
      } else if (gesture.kind === 'pan' && e.touches.length === 1) {
        const p = point(e.touches[0])
        if (Math.hypot(p.x - gesture.x, p.y - gesture.y) > TAP_SLOP) moved = true
        if (view.s > 1) show(clampView({ ...gesture.start, x: gesture.start.x + p.x - gesture.x, y: gesture.start.y + p.y - gesture.y }, f), false)
      }
    }
    const onEnd = (e: TouchEvent): void => {
      // One finger of a pinch lifting carries on as a drag from where the image is.
      begin(e.touches)
      if (e.touches.length === 0) show(clampView(view, frame()), true)
    }
    const onClick = (e: MouseEvent): void => {
      if (moved) {
        moved = false
        return
      }
      if (tapTimer !== undefined) {
        clearTimeout(tapTimer)
        tapTimer = undefined
        const r = el.getBoundingClientRect()
        show(doubleTapView(view, { x: e.clientX - r.left, y: e.clientY - r.top }, frame()), true)
        return
      }
      tapTimer = setTimeout(() => {
        tapTimer = undefined
        close.current()
      }, DOUBLE_TAP_MS)
    }
    // iOS's own pinch is already stopped (main.tsx); these must be able to cancel scrolling.
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    el.addEventListener('click', onClick)
    return () => {
      clearTimeout(tapTimer)
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      el.removeEventListener('click', onClick)
    }
  }, [])

  return (
    <div ref={box} className="m-lightbox" role="dialog" aria-modal="true" aria-label="Image. Tap to close, pinch or double tap to zoom.">
      <img ref={img} src={src} alt="" draggable={false} />
    </div>
  )
}
