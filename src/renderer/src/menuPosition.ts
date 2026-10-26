type Rect = { left: number; top: number; right: number; bottom: number }

/** Keep the menu near the pointer, preferring a clear spot around the selected text. */
export function menuPosition(
  x: number, y: number, width: number, height: number,
  viewport: { width: number; height: number; top?: number }, selection: Rect[]
): { left: number; top: number } {
  const gap = 8
  const clamp = (value: number, size: number, limit: number, inset = 0): number => Math.max(inset + gap, Math.min(value, limit - size - gap))
  const rects = selection.filter((r) => r.right > r.left && r.bottom > r.top && r.bottom > 0 && r.top < viewport.height)
  const candidates = [{ left: x + gap, top: y + gap }, { left: x - width - gap, top: y - height - gap }]
  if (rects.length) {
    const left = Math.min(...rects.map((r) => r.left))
    const right = Math.max(...rects.map((r) => r.right))
    const top = Math.min(...rects.map((r) => r.top))
    const bottom = Math.max(...rects.map((r) => r.bottom))
    candidates.unshift(
      { left: x, top: bottom + gap },
      { left: x, top: top - height - gap },
      { left: right + gap, top: y },
      { left: left - width - gap, top: y }
    )
  }
  return candidates.map((p) => {
    const left = clamp(p.left, width, viewport.width)
    const top = clamp(p.top, height, viewport.height, viewport.top)
    const overlap = rects.reduce((area, r) => area +
      Math.max(0, Math.min(left + width, r.right + gap) - Math.max(left, r.left - gap)) *
      Math.max(0, Math.min(top + height, r.bottom + gap) - Math.max(top, r.top - gap)), 0)
    const distance = Math.hypot(Math.max(left - x, 0, x - left - width), Math.max(top - y, 0, y - top - height))
    return { left, top, overlap, distance }
  // A clear spot wins. If every spot overlaps, stay near the pointer instead
  // of fleeing to an edge just to cover slightly less selected text.
  }).sort((a, b) => Number(a.overlap > 0) - Number(b.overlap > 0) || a.distance - b.distance || a.overlap - b.overlap)
    .map(({ left, top }) => ({ left, top }))[0]
}
