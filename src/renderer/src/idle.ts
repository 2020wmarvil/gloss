/** Give a newly mounted view a frame before scheduling bounded background work. */
export function afterPaintIdle(run: () => void): () => void {
  let frame = 0
  let idle: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancelled = false
  const work = (): void => { if (!cancelled) run() }
  if (typeof requestAnimationFrame === 'function') {
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (typeof requestIdleCallback === 'function') idle = requestIdleCallback(work, { timeout: 200 })
        else timer = setTimeout(work, 0)
      })
    })
  } else timer = setTimeout(work, 0)
  return () => {
    cancelled = true
    if (frame) cancelAnimationFrame(frame)
    if (idle !== undefined) cancelIdleCallback(idle)
    clearTimeout(timer)
  }
}
