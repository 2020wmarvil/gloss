import { describe, expect, it } from 'vitest'
import { BADGE_SIZE, badgePixels } from './badge'

describe('badgePixels', () => {
  const at = (px: Buffer, x: number, y: number): number[] => [...px.subarray((y * BADGE_SIZE + x) * 4, (y * BADGE_SIZE + x) * 4 + 4)]

  it('draws the state color in the middle, transparent padding, and no ring', () => {
    const px = badgePixels('working')
    expect(px.length).toBe(BADGE_SIZE * BADGE_SIZE * 4)
    // BGRA: #2c55c9.
    expect(at(px, 16, 16)).toEqual([0xc9, 0x55, 0x2c, 255])
    expect(at(px, 16, 1)).toEqual([0, 0, 0, 0])
    expect(at(px, 16, 7)).toEqual([0, 0, 0, 0])
    expect([...px].filter((_, i) => i % 4 === 3 && px[i] > 0).length).toBeLessThan(BADGE_SIZE * BADGE_SIZE / 4)
    expect(at(px, 0, 0)).toEqual([0, 0, 0, 0])
    expect(at(badgePixels('failed'), 16, 16)).toEqual([0x1c, 0x36, 0xc4, 255])
  })

  it('premultiplies the antialiased edge', () => {
    const px = badgePixels('completed')
    for (let i = 0; i < px.length; i += 4) {
      expect(Math.max(px[i], px[i + 1], px[i + 2])).toBeLessThanOrEqual(px[i + 3])
    }
  })
})
