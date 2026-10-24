import { describe, expect, it } from 'vitest'
import { captureHdr, scrgbToSdr } from './hdr'

/** Half floats for one RGBA pixel. */
const ONE = 0x3c00
const HALF = 0x3800
const NEG_ONE = 0xbc00
const INF = 0x7c00

describe('scrgbToSdr', () => {
  it('maps the SDR white level to white, and keeps the channels in BGRA order', () => {
    // At 240 nits, scRGB 3.0 is white; 1.0 is a third of it.
    const THREE = 0x4200
    const px = scrgbToSdr(new Uint16Array([THREE, ONE, 0, ONE]), 4, 1, 1, 240)
    expect([...px]).toEqual([0, 156, 255, 255])
  })

  it('at 80 nits, takes scRGB as it is: sRGB-encodes linear values', () => {
    const px = scrgbToSdr(new Uint16Array([ONE, HALF, 0, ONE]), 4, 1, 1, 80)
    expect([...px]).toEqual([0, 188, 255, 255])
  })

  it('clips brighter-than-white, negative and non-finite values', () => {
    const px = scrgbToSdr(new Uint16Array([0x4800, NEG_ONE, INF, ONE]), 4, 1, 1, 80)
    expect([...px]).toEqual([0, 0, 255, 255])
  })

  it('skips the padding at the end of each row', () => {
    const rows = new Uint16Array([ONE, ONE, ONE, ONE, 0xffff, 0xffff, 0, 0, 0, ONE, 0xffff, 0xffff])
    expect([...scrgbToSdr(rows, 6, 1, 2, 80)]).toEqual([255, 255, 255, 255, 0, 0, 0, 255])
  })
})

describe('captureHdr', () => {
  it('leaves every display to desktopCapturer off Windows', async () => {
    expect(await captureHdr([{ x: 0, y: 0, width: 10, height: 10 }], 'linux')).toEqual([null])
  })
})
