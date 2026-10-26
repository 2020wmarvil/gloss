import { describe, expect, it } from 'vitest'
import { menuPosition } from './menuPosition'

const viewport = { width: 800, height: 600 }
describe('selection menu placement', () => {
  it('clears a selected line below the pointer', () => {
    const p = menuPosition(200, 220, 200, 80, viewport, [{ left: 100, top: 200, right: 500, bottom: 224 }])
    expect(p.top).toBe(232)
  })
  it('opens above text near the bottom edge', () => {
    const p = menuPosition(300, 565, 200, 80, viewport, [{ left: 50, top: 550, right: 750, bottom: 580 }])
    expect(p.top).toBe(462)
  })
  it('uses the side for a tall selection when it is closer', () => {
    const p = menuPosition(410, 300, 200, 80, viewport, [{ left: 100, top: 50, right: 420, bottom: 550 }])
    expect(p.left).toBe(428)
  })
  it('keeps the measured menu inside the viewport without a selection', () => {
    const p = menuPosition(799, 599, 240, 110, viewport, [])
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.left + 240).toBeLessThanOrEqual(792)
    expect(p.top + 110).toBeLessThanOrEqual(592)
  })
  it('stays in bounds when overlap cannot be avoided', () => {
    const p = menuPosition(400, 300, 200, 80, viewport, [{ left: 0, top: 0, right: 800, bottom: 600 }])
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.top).toBeGreaterThanOrEqual(8)
    expect(p.left + 200).toBeLessThanOrEqual(792)
    expect(p.top + 80).toBeLessThanOrEqual(592)
  })

  it('keeps the menu below the title bar', () => {
    const p = menuPosition(400, 10, 216, 83, { ...viewport, top: 40 }, [])
    expect(p.top).toBeGreaterThanOrEqual(48)
    expect(p.top + 83).toBeLessThanOrEqual(592)
  })

  it('stays near the pointer when a long selection leaves no clear space', () => {
    const p = menuPosition(400, 300, 216, 83, { ...viewport, top: 40 }, [{ left: 0, top: -200, right: 800, bottom: 900 }])
    expect(p.top).toBeGreaterThan(200)
    expect(p.top).toBeLessThan(400)
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.left + 216).toBeLessThanOrEqual(792)
  })
})
