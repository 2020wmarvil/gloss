import { expect, it } from 'vitest'
import { dragRect, magnifierAt, windowAt } from './region'

it('finds the topmost window under the cursor, or none over the desktop', () => {
  const windows = [
    { title: 'top', rect: { x: 100, y: 100, width: 200, height: 200 } },
    { title: 'below', rect: { x: 0, y: 0, width: 500, height: 500 } }
  ]
  expect(windowAt(windows, { x: 150, y: 150 })?.title).toBe('top')
  expect(windowAt(windows, { x: 300, y: 150 })?.title).toBe('below')
  expect(windowAt(windows, { x: 500, y: 10 })).toBeNull()
})

it('drags a region in any direction, both ends included, squared with Shift and clipped', () => {
  expect(dragRect({ x: 10, y: 10 }, { x: 19, y: 14 }, false, 100, 100)).toEqual({ x: 10, y: 10, width: 10, height: 5 })
  expect(dragRect({ x: 19, y: 14 }, { x: 10, y: 10 }, false, 100, 100)).toEqual({ x: 10, y: 10, width: 10, height: 5 })
  expect(dragRect({ x: 10, y: 10 }, { x: 19, y: 14 }, true, 100, 100)).toEqual({ x: 10, y: 10, width: 10, height: 10 })
  expect(dragRect({ x: 10, y: 10 }, { x: 5, y: 12 }, true, 100, 100)).toEqual({ x: 5, y: 10, width: 6, height: 6 })
  expect(dragRect({ x: 95, y: 95 }, { x: 99, y: 90 }, true, 100, 100)).toEqual({ x: 95, y: 90, width: 5, height: 6 })
})

it('puts the magnifier below right of the cursor, flipped at the edges', () => {
  expect(magnifierAt({ x: 100, y: 100 }, 150, 24, 30, 1920, 1080)).toEqual({ x: 124, y: 124 })
  expect(magnifierAt({ x: 1900, y: 100 }, 150, 24, 30, 1920, 1080)).toEqual({ x: 1726, y: 124 })
  expect(magnifierAt({ x: 100, y: 1000 }, 150, 24, 30, 1920, 1080)).toEqual({ x: 124, y: 796 })
})
