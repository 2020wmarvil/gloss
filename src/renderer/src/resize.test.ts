import { describe, expect, it } from 'vitest'
import { clampWidth, sidebarLimits, threadPanelLimits } from './resize'

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

  it('leaves the conversation at least 360px beside the thread panel', () => {
    expect(threadPanelLimits(1920, 240)).toEqual({ min: 320, max: 1320 })
  })
})
