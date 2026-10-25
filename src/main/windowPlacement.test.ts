import { expect, it } from 'vitest'
import { boundsArg, onScreen, placeSessionWindow } from './windowPlacement'

const left = { x: -2560, y: 0, width: 2560, height: 1400 }
const right = { x: 0, y: 0, width: 2560, height: 1400 }

it('opens where the last session window was, offset from a window already there', () => {
  const saved = { x: 100, y: 80, width: 900, height: 700 }
  expect(placeSessionWindow(saved, [], [left, right], right)).toEqual(saved)
  expect(placeSessionWindow(saved, [saved], [left, right], right)).toEqual({ ...saved, x: 128, y: 108 })
  expect(placeSessionWindow(saved, [saved, { ...saved, x: 128, y: 108 }], [left, right], right)).toEqual({ ...saved, x: 156, y: 136 })
  // On the other display too.
  const other = { x: -2000, y: 200, width: 900, height: 700 }
  expect(placeSessionWindow(other, [], [left, right], right)).toEqual(other)
})

it('opens at the default size centered on the main display without saved bounds, or when they are off screen', () => {
  expect(placeSessionWindow(null, [], [right], right)).toEqual({ x: 730, y: 310, width: 1100, height: 780 })
  // The display it was on is gone.
  expect(placeSessionWindow({ x: -2000, y: 200, width: 900, height: 700 }, [], [right], right)).toEqual({ x: 730, y: 310, width: 1100, height: 780 })
  // A small display shrinks it.
  expect(placeSessionWindow(null, [], [{ x: 0, y: 0, width: 1000, height: 700 }], { x: 0, y: 0, width: 1000, height: 700 })).toEqual({ x: 0, y: 0, width: 1000, height: 700 })
})

it('counts a window as on screen only while its title bar can be grabbed', () => {
  expect(onScreen({ x: 2500, y: 100, width: 900, height: 700 }, [right])).toBe(false)
  expect(onScreen({ x: 2400, y: 100, width: 900, height: 700 }, [right])).toBe(true)
  expect(onScreen({ x: 100, y: -500, width: 900, height: 700 }, [right])).toBe(false)
  expect(onScreen({ x: 100, y: 1390, width: 900, height: 700 }, [right])).toBe(false)
})

it('reads saved bounds back only when they are a usable rectangle', () => {
  expect(boundsArg({ x: 1, y: 2, width: 800, height: 600 })).toEqual({ x: 1, y: 2, width: 800, height: 600 })
  expect(boundsArg({ x: 1, y: 2, width: 10, height: 600 })).toBeNull()
  expect(boundsArg({ x: '1', y: 2, width: 800, height: 600 })).toBeNull()
  expect(boundsArg(null)).toBeNull()
})
