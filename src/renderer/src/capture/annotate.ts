// The annotation canvas's drawing (SPEC → Visual feedback): pins and marks over a capture, and
// the flattened image that is sent.
import type { Capture } from '@shared/capture'
import type { Attachment, Pin } from '@shared/types'

export type Tool = 'pin' | 'pen' | 'highlighter' | 'box' | 'arrow'

/** A drawn mark, in the capture's pixels. */
export type Shape =
  | { type: 'pen' | 'highlighter'; color: string; points: [number, number][] }
  | { type: 'box' | 'arrow'; color: string; x1: number; y1: number; x2: number; y2: number }

/** A capture being annotated, kept so the composer can reopen it (Edit) until it is sent. */
export type Annotation = { capture: Capture; shapes: Shape[]; pins: Pin[] }

/** Pins are always Gloss's pink, so they read as anchors; the colors are for marks. */
export const PIN_COLOR = '#e0157f'
export const MARK_COLORS = ['#e5372b', '#f5b700', '#2c7be5', '#2e9e4f', '#1c1b18']

/** The Anthropic API refuses images over 5 MB (as base64): larger captures go as JPEG. */
const MAX_PNG_BASE64 = 5 * 1024 * 1024

const FONT = '"Inter Gloss", system-ui, "Segoe UI", sans-serif'

/** A pin's radius in the capture's pixels: readable on small and large captures alike. */
export function pinRadius(width: number, height: number): number {
  return Math.max(12, Math.min(28, Math.round(Math.min(width, height) * 0.025)))
}

export function drawShape(ctx: CanvasRenderingContext2D, s: Shape, r: number): void {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = s.color
  ctx.lineWidth = Math.max(3, Math.round(r * 0.26))
  if ('points' in s) {
    if (s.type === 'highlighter') {
      ctx.globalCompositeOperation = 'multiply'
      ctx.globalAlpha = 0.4
      ctx.lineWidth = r * 1.5
      ctx.lineCap = 'butt'
    }
    ctx.beginPath()
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.stroke()
  } else if (s.type === 'box') {
    ctx.strokeRect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1))
  } else {
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1)
    const head = r * 1.2
    ctx.beginPath()
    ctx.moveTo(s.x1, s.y1)
    ctx.lineTo(s.x2, s.y2)
    ctx.moveTo(s.x2 - head * Math.cos(a - 0.45), s.y2 - head * Math.sin(a - 0.45))
    ctx.lineTo(s.x2, s.y2)
    ctx.lineTo(s.x2 - head * Math.cos(a + 0.45), s.y2 - head * Math.sin(a + 0.45))
    ctx.stroke()
  }
  ctx.restore()
}

/** A numbered pin: a pink disc with a white rim and number. `lit` rings it (its note is hovered). */
export function drawPin(ctx: CanvasRenderingContext2D, p: Pin, n: number, r: number, lit = false): void {
  ctx.save()
  if (lit) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, r + 6, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(224, 21, 127, 0.25)'
    ctx.fill()
  }
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)'
  ctx.shadowBlur = 4
  ctx.shadowOffsetY = 1
  ctx.beginPath()
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
  ctx.fillStyle = PIN_COLOR
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = Math.max(2, r * 0.16)
  ctx.strokeStyle = '#fff'
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.font = `700 ${Math.round(r * (n > 9 ? 0.85 : 1.05))}px ${FONT}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(n), p.x, p.y + 1)
  ctx.restore()
}

/** Draws the capture with its marks, then its pins on top. */
export function paint(ctx: CanvasRenderingContext2D, image: CanvasImageSource, a: Omit<Annotation, 'capture'> & { width: number; height: number }, extra?: Shape, lit = -1): void {
  const r = pinRadius(a.width, a.height)
  ctx.clearRect(0, 0, a.width, a.height)
  ctx.drawImage(image, 0, 0)
  for (const s of a.shapes) drawShape(ctx, s, r)
  if (extra) drawShape(ctx, extra, r)
  a.pins.forEach((p, i) => drawPin(ctx, p, i + 1, r, i === lit))
}

export function loadImage(capture: Capture): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Couldn't read the capture."))
    img.src = `data:${capture.mimeType ?? 'image/png'};base64,${capture.data}`
  })
}

/** The topmost pin within reach of the point, or -1. */
export function pinAt(pins: Pin[], x: number, y: number, r: number): number {
  for (let i = pins.length - 1; i >= 0; i--) if (Math.hypot(pins[i].x - x, pins[i].y - y) <= r + 3) return i
  return -1
}

/** A mark too small to mean anything (a click with a drawing tool). */
export function isTiny(s: Shape): boolean {
  return 'points' in s ? s.points.length < 2 : Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 4
}

/** The annotated capture as the image attachment that is sent: marks and pins drawn in, the pins kept. */
export async function flatten(a: Annotation): Promise<Extract<Attachment, { kind: 'image' }>> {
  const { width, height } = a.capture
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  paint(canvas.getContext('2d')!, await loadImage(a.capture), { width, height, shapes: a.shapes, pins: a.pins })
  let url = canvas.toDataURL('image/png')
  let mimeType = 'image/png'
  if (url.length - url.indexOf(',') - 1 > MAX_PNG_BASE64) {
    url = canvas.toDataURL('image/jpeg', 0.9)
    mimeType = 'image/jpeg'
  }
  const pins = a.pins.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), note: p.note.trim() }))
  // An attached image (its source is its file name) keeps its name; a capture is a screenshot.
  const base = a.capture.mimeType ? a.capture.source.replace(/\.[^.]*$/, '') || 'image' : 'screenshot'
  return {
    kind: 'image',
    name: `${base}.${mimeType === 'image/png' ? 'png' : 'jpg'}`,
    mimeType,
    data: url.slice(url.indexOf(',') + 1),
    ...(pins.length > 0 ? { pins } : {})
  }
}
