/** Where a new session window opens (SPEC → Session windows → Restart). */

export type Rect = { x: number; y: number; width: number; height: number }

export const SESSION_WINDOW_SIZE = { width: 1100, height: 780 }

/** How far a window opening over another one moves down and right. */
const OFFSET = 28

/** The part of a window's top edge that must be on a display to count as on screen: enough to grab it. */
const GRAB = { width: 120, height: 32 }

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  }
}

/** The window's title bar can be grabbed on one of the displays. */
export function onScreen(bounds: Rect, workAreas: Rect[]): boolean {
  const top = { ...bounds, height: Math.min(bounds.height, GRAB.height) }
  return workAreas.some((area) => {
    const o = overlap(top, area)
    return o.width >= Math.min(GRAB.width, bounds.width) && o.height >= Math.min(GRAB.height, top.height)
  })
}

/** The default size, centered on `home` (the main window's display), shrunk to fit it. */
function centered(home: Rect): Rect {
  const width = Math.min(SESSION_WINDOW_SIZE.width, home.width)
  const height = Math.min(SESSION_WINDOW_SIZE.height, home.height)
  return {
    x: Math.round(home.x + (home.width - width) / 2),
    y: Math.round(home.y + (home.height - height) / 2),
    width,
    height
  }
}

/**
 * The saved bounds of the last session window, or the default size centered on `home`
 * when there are none or they are off screen; moved down and right while a window
 * already open (`taken`) starts at the same spot.
 */
export function placeSessionWindow(saved: Rect | null, taken: Rect[], workAreas: Rect[], home: Rect): Rect {
  let bounds = saved && onScreen(saved, workAreas) ? { ...saved } : centered(home)
  for (let i = 0; i < 20 && taken.some((t) => t.x === bounds.x && t.y === bounds.y); i++) {
    bounds = { ...bounds, x: bounds.x + OFFSET, y: bounds.y + OFFSET }
  }
  return bounds
}

/** Saved bounds read back from disk, or null if they aren't a rectangle. */
export function boundsArg(value: unknown): Rect | null {
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  const ok = ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]))
  if (!ok || (r.width as number) < 100 || (r.height as number) < 100) return null
  return { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number }
}
