// The region overlay's geometry (SPEC → Visual feedback), in the frozen display's pixels.
import type { CaptureRect, CaptureWindow } from '@shared/capture'

export type Point = { x: number; y: number }

/** Below this drag distance a press is a click (on a window, or the display). */
export const DRAG_THRESHOLD = 3
/** A region narrower or shorter than this is dropped, as in ShareX. */
export const MIN_REGION = 5

/** The topmost window under the point, or null over the desktop. */
export function windowAt(windows: CaptureWindow[], p: Point): CaptureWindow | null {
  return windows.find((w) => p.x >= w.rect.x && p.x < w.rect.x + w.rect.width && p.y >= w.rect.y && p.y < w.rect.y + w.rect.height) ?? null
}

/**
 * The region dragged from `start` to `end`, both pixels included. With `square`, its sides are
 * the longer of the two, growing away from `start`. Clipped to the display.
 */
export function dragRect(start: Point, end: Point, square: boolean, width: number, height: number): CaptureRect {
  let w = Math.abs(end.x - start.x) + 1
  let h = Math.abs(end.y - start.y) + 1
  if (square) w = h = Math.max(w, h)
  const x = end.x < start.x ? start.x - w + 1 : start.x
  const y = end.y < start.y ? start.y - h + 1 : start.y
  const left = Math.max(0, x)
  const top = Math.max(0, y)
  return { x: left, y: top, width: Math.min(width, x + w) - left, height: Math.min(height, y + h) - top }
}

/**
 * Where the magnifier (a `size` square) goes: below right of the cursor, flipped left or up
 * near the display's edges, leaving `below` under it for the coordinates.
 */
export function magnifierAt(cursor: Point, size: number, gap: number, below: number, width: number, height: number): Point {
  let x = cursor.x + gap
  let y = cursor.y + gap
  if (x + size > width) x = cursor.x - gap - size
  if (y + size + below > height) y = cursor.y - gap - size - below
  return { x: Math.max(0, x), y: Math.max(0, y) }
}
