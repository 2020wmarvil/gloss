// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoscrollSpeed, DEAD_ZONE, startAutoscroll } from './autoscroll'

describe('autoscrollSpeed', () => {
  it("is still near the anchor and faster further out, in the pointer's direction", () => {
    expect(autoscrollSpeed(0)).toBe(0)
    expect(autoscrollSpeed(DEAD_ZONE)).toBe(0)
    expect(autoscrollSpeed(-DEAD_ZONE)).toBe(0)
    expect(autoscrollSpeed(60)).toBeGreaterThan(0)
    expect(autoscrollSpeed(-60)).toBe(-autoscrollSpeed(60))
    expect(autoscrollSpeed(200)).toBeGreaterThan(autoscrollSpeed(60) * 3)
  })
})

describe('startAutoscroll', () => {
  let frames: FrameRequestCallback[] = []
  let now = 0
  afterEach(() => {
    vi.restoreAllMocks()
    frames = []
  })
  const setup = (): { scroll: ReturnType<typeof vi.fn<(dx: number, dy: number) => void>>; step(ms: number): void } => {
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((f) => frames.push(f))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => (frames = []))
    const scroll = vi.fn<(dx: number, dy: number) => void>()
    return {
      scroll,
      step(ms) {
        now += ms
        const due = frames
        frames = []
        for (const f of due) f(now)
      }
    }
  }
  const mouse = (type: string, init: MouseEventInit): void => void window.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))

  it('scrolls toward the pointer and shows the anchor until the next click', () => {
    const { scroll, step } = setup()
    startAutoscroll(100, 100, scroll)
    expect(document.querySelector('.autoscroll-anchor')).not.toBeNull()
    expect(document.documentElement.classList.contains('autoscrolling')).toBe(true)
    // Released without moving: it keeps going.
    mouse('mouseup', { button: 1, clientX: 100, clientY: 100 })
    mouse('mousemove', { clientX: 160, clientY: 95 })
    step(100)
    expect(scroll).toHaveBeenLastCalledWith(Math.trunc(autoscrollSpeed(60) / 10), 0)
    const click = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    window.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(document.querySelector('.autoscroll-anchor')).toBeNull()
    expect(document.documentElement.classList.contains('autoscrolling')).toBe(false)
    scroll.mockClear()
    step(100)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('stops when the button is released after a drag, and on a key', () => {
    const { scroll, step } = setup()
    startAutoscroll(100, 100, scroll)
    mouse('mousemove', { clientX: 100, clientY: 40 })
    mouse('mouseup', { button: 1 })
    expect(document.querySelector('.autoscroll-anchor')).toBeNull()
    startAutoscroll(100, 100, scroll)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    window.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true)
    expect(document.querySelector('.autoscroll-anchor')).toBeNull()
    scroll.mockClear()
    step(100)
    expect(scroll).not.toHaveBeenCalled()
  })
})
