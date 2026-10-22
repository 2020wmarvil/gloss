// The taskbar badge (SPEC → Notifications): a dot over the app's icon for what needs the
// user, drawn here so no image files ship with it.

import type { AppBadge } from '../shared/ipc'

/** The light theme's state colors (styles.css), as [r, g, b]. */
const COLORS: Record<NonNullable<AppBadge['state']>, [number, number, number]> = {
  working: [0x2c, 0x55, 0xc9],
  completed: [0x2e, 0x7d, 0x32],
  failed: [0xc4, 0x36, 0x1c]
}

/** Side of the bitmap: a 16 px overlay at twice the scale. */
export const BADGE_SIZE = 32

/**
 * A filled dot in the state's color inside a white ring, as premultiplied BGRA pixels
 * (what `nativeImage.createFromBitmap` takes), edges antialiased.
 */
export function badgePixels(state: NonNullable<AppBadge['state']>, size = BADGE_SIZE): Buffer {
  const [r, g, b] = COLORS[state]
  const out = Buffer.alloc(size * size * 4)
  const c = size / 2
  const outer = size / 2 - 0.5
  const inner = outer - size / 10
  // Coverage of a pixel by a disc of radius `radius`: 1 inside, 0 outside, linear over 1 px.
  const cover = (d: number, radius: number): number => Math.min(1, Math.max(0, radius - d + 0.5))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      const alpha = cover(d, outer)
      const fill = cover(d, inner)
      // The ring is white; the fill blends over it.
      const mix = (channel: number): number => Math.round((channel * fill + 255 * (1 - fill)) * alpha)
      const i = (y * size + x) * 4
      out[i] = mix(b)
      out[i + 1] = mix(g)
      out[i + 2] = mix(r)
      out[i + 3] = Math.round(255 * alpha)
    }
  }
  return out
}

export const BADGE_LABEL: Record<NonNullable<AppBadge['state']>, string> = {
  working: 'Working',
  completed: 'Finished',
  failed: 'A turn failed'
}
