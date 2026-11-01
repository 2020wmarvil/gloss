// Middle-click autoscroll, as on Windows (SPEC → Review sessions → Diff view): a middle click
// drops an anchor, and the pointer's distance from it sets the scroll speed in each direction.

/** How far the pointer can stray from the anchor before anything scrolls, in px. */
export const DEAD_ZONE = 10

/** Scroll speed in px per second for a pointer `d` px from the anchor along one axis, faster further out. */
export function autoscrollSpeed(d: number): number {
  const a = Math.abs(d) - DEAD_ZONE
  return a <= 0 ? 0 : Math.sign(d) * (a * 6 + (a * a) / 40)
}

/** The element that scrolls `el` vertically: its nearest ancestor with room to scroll. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p)
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

const ANCHOR_ICON =
  '<svg viewBox="0 0 28 28" aria-hidden="true"><circle cx="14" cy="14" r="2"/><path d="M14 3 10.5 7h7zM14 25l-3.5-4h7zM3 14l4-3.5v7zM25 14l-4-3.5v7z"/></svg>'

/**
 * Starts autoscrolling from a middle button press at (`x`, `y`). `scroll` gets whole pixels
 * to move by. Moving the pointer while the button is held and then releasing it stops, like
 * a drag; a click without moving keeps going until the next click, a key, the wheel, or the
 * window losing focus. Returns `stop`, which ends it early.
 */
export function startAutoscroll(x: number, y: number, scroll: (dx: number, dy: number) => void): () => void {
  const anchor = document.createElement('div')
  anchor.className = 'autoscroll-anchor'
  anchor.style.left = `${x}px`
  anchor.style.top = `${y}px`
  anchor.innerHTML = ANCHOR_ICON
  document.body.append(anchor)
  document.documentElement.classList.add('autoscrolling')

  let px = x
  let py = y
  let dragged = false
  let last = performance.now()
  let ax = 0
  let ay = 0
  let frame = 0

  const tick = (now: number): void => {
    const dt = Math.min(now - last, 100) / 1000
    last = now
    ax += autoscrollSpeed(px - x) * dt
    ay += autoscrollSpeed(py - y) * dt
    const dx = Math.trunc(ax)
    const dy = Math.trunc(ay)
    ax -= dx
    ay -= dy
    if (dx || dy) scroll(dx, dy)
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)

  // The press that ends it (and its click) does nothing else.
  const swallow = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  const onMove = (e: MouseEvent): void => {
    px = e.clientX
    py = e.clientY
    if (Math.max(Math.abs(px - x), Math.abs(py - y)) > DEAD_ZONE) dragged = true
  }
  const onDown = (e: MouseEvent): void => {
    swallow(e)
    stop()
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.addEventListener('auxclick', swallow, { capture: true, once: true })
    // A click that never comes would swallow a later one.
    setTimeout(() => {
      window.removeEventListener('click', swallow, true)
      window.removeEventListener('auxclick', swallow, true)
    }, 500)
  }
  const onUp = (e: MouseEvent): void => {
    if (e.button === 1 && dragged) stop()
  }
  const onKey = (e: KeyboardEvent): void => {
    swallow(e)
    stop()
  }
  const listeners: [string, EventListener][] = [
    ['mousemove', onMove as EventListener],
    ['mousedown', onDown as EventListener],
    ['mouseup', onUp as EventListener],
    ['keydown', onKey as EventListener],
    ['wheel', stop],
    ['blur', stop]
  ]

  let stopped = false
  function stop(): void {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(frame)
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true)
    anchor.remove()
    document.documentElement.classList.remove('autoscrolling')
  }
  for (const [type, fn] of listeners) window.addEventListener(type, fn, true)
  return stop
}
