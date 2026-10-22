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

/** A small plain dot matching the in-app status dots, with transparent padding.
 * Keep the full overlay canvas so Windows doesn't scale the dot up to fill it.
 * Pixels are antialiased, premultiplied BGRA for nativeImage.createFromBitmap.
 */
export function badgePixels(state: NonNullable<AppBadge['state']>, size = BADGE_SIZE): Buffer {
  const [r, g, b] = COLORS[state]
  const out = Buffer.alloc(size * size * 4)
  const c = size / 2
  const radius = size / 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c)
      const alpha = Math.min(1, Math.max(0, radius - d + 0.5))
      const i = (y * size + x) * 4
      out[i] = Math.round(b * alpha)
      out[i + 1] = Math.round(g * alpha)
      out[i + 2] = Math.round(r * alpha)
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
