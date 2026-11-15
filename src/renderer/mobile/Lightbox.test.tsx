// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampView, doubleTapView, Lightbox, zoomAbout, type Frame } from './Lightbox'

// A 400x300 image centered on a 400x800 viewer.
const f: Frame = { left: 0, top: 250, w: 400, h: 300, vw: 400, vh: 800 }

describe('zoom math', () => {
  it('keeps the image point under the fingers while scaling', () => {
    const v = zoomAbout({ s: 1, x: 0, y: 0 }, 2, { x: 100, y: 400 }, { x: 100, y: 400 }, f)
    // Image point (100, 150) stays at viewer point (100, 400).
    expect(f.left + v.x + v.s * 100).toBe(100)
    expect(f.top + v.y + v.s * 150).toBe(400)
  })

  it('holds the scale between 1 and 5 and leaves no gap at the edges', () => {
    expect(clampView({ s: 0.5, x: 30, y: -20 }, f)).toEqual({ s: 1, x: 0, y: 0 })
    expect(clampView({ s: 9, x: 0, y: 0 }, f).s).toBe(5)
    // At 2x the image is 800x600: wider than the viewer, so its sides stay off screen;
    // shorter, so it stays centered top to bottom.
    const v = clampView({ s: 2, x: 100, y: 0 }, f)
    expect(v.x + 0).toBe(0)
    expect(clampView({ s: 2, x: -1000, y: 0 }, f).x).toBe(-400)
    // 600 tall in 800: top at 100, bottom at 700.
    expect(f.top + v.y).toBe(100)
  })

  it('double tap zooms in at the spot, and out again', () => {
    const v = doubleTapView({ s: 1, x: 0, y: 0 }, { x: 200, y: 400 }, f)
    expect(v.s).toBe(2.5)
    expect(f.left + v.x + v.s * 200).toBe(200)
    expect(doubleTapView(v, { x: 10, y: 10 }, f)).toEqual({ s: 1, x: 0, y: 0 })
  })
})

describe('Lightbox', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let root: Root | null = null
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    vi.useRealTimers()
  })

  function mount(onClose: () => void): HTMLElement {
    const el = document.createElement('div')
    document.body.replaceChildren(el)
    root = createRoot(el)
    act(() => root!.render(<Lightbox src="data:image/png;base64," onClose={onClose} />))
    return document.querySelector<HTMLElement>('.m-lightbox')!
  }

  it('closes on a tap, but not on a double tap', () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const box = mount(onClose)
    box.click()
    box.click()
    vi.advanceTimersByTime(500)
    expect(onClose).not.toHaveBeenCalled()
    box.click()
    vi.advanceTimersByTime(500)
    expect(onClose).toHaveBeenCalledOnce()
  })
})
