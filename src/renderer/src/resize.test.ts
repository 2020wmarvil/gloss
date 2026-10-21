import { describe, expect, it } from 'vitest'
import { clampWidth, fitPanes, sidebarLimits, threadPanelDefault, threadPanelLimits } from './resize'

describe('pane widths', () => {
  it('clamps to the limits', () => {
    expect(clampWidth(100, { min: 180, max: 480 })).toBe(180)
    expect(clampWidth(300.4, { min: 180, max: 480 })).toBe(300)
    expect(clampWidth(900, { min: 180, max: 480 })).toBe(480)
  })

  it('keeps the minimum when the window is too small for the maximum', () => {
    expect(clampWidth(500, { min: 320, max: 100 })).toBe(320)
  })

  it('caps the sidebar at 480px or 40% of the window', () => {
    expect(sidebarLimits(1920)).toEqual({ min: 180, max: 480 })
    expect(sidebarLimits(800)).toEqual({ min: 180, max: 320 })
  })

  it('leaves room for the side panel when the sidebar is dragged', () => {
    expect(sidebarLimits(1000, 420)).toEqual({ min: 180, max: 320 })
    expect(sidebarLimits(1000, null)).toEqual({ min: 180, max: 400 })
  })

  it('leaves the conversation at least 360px beside the thread panel', () => {
    expect(threadPanelLimits(1920, 240)).toEqual({ min: 320, max: 1320 })
  })

  it('grows the thread panel with the window by default', () => {
    expect(threadPanelDefault(900)).toBe(420)
    expect(threadPanelDefault(1500)).toBe(480)
    expect(threadPanelDefault(2560)).toBe(600)
  })
})

describe('fitting the panes', () => {
  it('keeps the wanted widths when they fit', () => {
    expect(fitPanes(1400, { sidebar: 240, side: 448 }, 'side')).toEqual({ sidebar: 240, side: 448 })
  })

  it('narrows the thread panel first, then the sidebar', () => {
    expect(fitPanes(960, { sidebar: 240, side: 420 }, 'side')).toEqual({ sidebar: 240, side: 360 })
    expect(fitPanes(880, { sidebar: 240, side: 420 }, 'side')).toEqual({ sidebar: 200, side: 320 })
  })

  it('collapses the pane opened first when both still do not fit', () => {
    expect(fitPanes(900, { sidebar: 240, side: 420 }, 'side')).toEqual({ sidebar: 220, side: 320 })
    expect(fitPanes(800, { sidebar: 240, side: 420 }, 'side')).toEqual({ sidebar: null, side: 396 })
    expect(fitPanes(800, { sidebar: 240, side: 420 }, 'sidebar')).toEqual({ sidebar: 240, side: null })
  })

  it('counts the rails, and the conversation alone when there is no side panel', () => {
    expect(fitPanes(720, { sidebar: 240, side: undefined }, 'side')).toEqual({ sidebar: 240, side: undefined })
    expect(fitPanes(720, { sidebar: null, side: 420 }, 'side')).toEqual({ sidebar: null, side: 320 })
  })
})
