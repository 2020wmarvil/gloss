// The region overlay (SPEC → Visual feedback), as ShareX's region capture, one per display: a
// frozen copy of the display, dimmed except the area that would be captured. Hover highlights the window under the
// cursor and a click takes it; a drag takes a region (Shift: a square); Space takes the whole
// display; right-click drops the region being drawn, or cancels; Esc cancels. A magnifier
// beside the cursor shows the pixels around it, at 10×.
import type { CaptureChoice, CaptureFrame, CaptureOverlayApi, CaptureRect } from '@shared/capture'
import { dragRect, DRAG_THRESHOLD, magnifierAt, MIN_REGION, windowAt, type Point } from './region'
import './overlay.css'

declare global {
  interface Window {
    glossCapture: CaptureOverlayApi
  }
}

const ACCENT = '#ff3da6'
/** ShareX's dimming: 20% black over what won't be captured. */
const DIM = 'rgba(0, 0, 0, 0.2)'
/** The magnifier shows 15 × 15 pixels at 10×. */
const MAG_PIXELS = 15
const MAG_ZOOM = 10
const FONT = '"Inter Gloss", system-ui, "Segoe UI", sans-serif'

const frameCanvas = document.getElementById('frame') as HTMLCanvasElement
const canvas = document.getElementById('overlay') as HTMLCanvasElement
const hint = document.getElementById('hint')!
const ctx = canvas.getContext('2d')!

let frame: CaptureFrame | null = null
let source: HTMLCanvasElement | null = null
/** Display pixels per CSS pixel. */
let k = 1
const cursor: Point = { x: 0, y: 0 }
/** Where the left button went down, while it is held. */
let down: Point | null = null
let dragging = false
let square = false
let ant = 0
let finished = false
/** The cursor is on this overlay's display: there is one overlay per display. */
let inside = false

function finish(choice: CaptureChoice): void {
  if (finished) return
  finished = true
  void window.glossCapture.done(choice)
}

function displayRect(): CaptureRect {
  return { x: 0, y: 0, width: frame!.width, height: frame!.height }
}

/** What a click, or the drag so far, would capture. */
function active(): { rect: CaptureRect; kind: 'region' | 'window' | 'display'; title?: string } {
  if (dragging && down) return { rect: dragRect(down, cursor, square, frame!.width, frame!.height), kind: 'region' }
  const w = windowAt(frame!.windows, cursor)
  return w ? { rect: w.rect, kind: 'window', title: w.title } : { rect: displayRect(), kind: 'display' }
}

function label(text: string, x: number, y: number): number {
  ctx.font = `500 ${12 * k}px ${FONT}`
  const w = ctx.measureText(text).width + 14 * k
  ctx.fillStyle = 'rgba(20, 19, 18, 0.82)'
  ctx.beginPath()
  ctx.roundRect(x, y, w, 22 * k, 5 * k)
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + 7 * k, y + 11.5 * k)
  return w
}

function draw(): void {
  if (!frame || !source) return
  const { width, height } = frame
  ant = (ant + 0.5) % 10
  ctx.clearRect(0, 0, width, height)
  if (!inside && !dragging) {
    // The cursor is on another display: this one is all dimmed.
    ctx.fillStyle = DIM
    ctx.fillRect(0, 0, width, height)
    return
  }
  const a = active().rect
  ctx.fillStyle = DIM
  ctx.beginPath()
  ctx.rect(0, 0, width, height)
  ctx.rect(a.x, a.y, a.width, a.height)
  ctx.fill('evenodd')

  // A 1px accent outline with black marching ants over it.
  const line = Math.max(1, Math.round(k))
  ctx.save()
  ctx.lineWidth = line
  const inset = line / 2
  ctx.strokeStyle = ACCENT
  ctx.strokeRect(a.x + inset, a.y + inset, a.width - line, a.height - line)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)'
  ctx.setLineDash([5 * line, 5 * line])
  ctx.lineDashOffset = -ant * line
  ctx.strokeRect(a.x + inset, a.y + inset, a.width - line, a.height - line)
  ctx.restore()

  if (dragging) {
    // A crosshair at the region's center, and its size at its corner.
    const cx = Math.floor(a.x + a.width / 2)
    const cy = Math.floor(a.y + a.height / 2)
    const r = Math.round(4 * k)
    ctx.fillStyle = '#000'
    ctx.fillRect(cx - r - line, cy - line, 2 * r + 3 * line, 3 * line)
    ctx.fillRect(cx - line, cy - r - line, 3 * line, 2 * r + 3 * line)
    ctx.fillStyle = ACCENT
    ctx.fillRect(cx - r, cy, 2 * r + line, line)
    ctx.fillRect(cx, cy - r, line, 2 * r + line)
    const top = a.y >= 28 * k ? a.y - 28 * k : a.y + 6 * k
    label(`${a.width} × ${a.height}`, a.x, top)
  }

  // The magnifier: the pixels around the cursor at 10×, the center one outlined.
  const cell = MAG_ZOOM * k
  const size = MAG_PIXELS * cell
  const half = Math.floor(MAG_PIXELS / 2)
  const m = magnifierAt(cursor, size, 24 * k, 30 * k, width, height)
  ctx.save()
  ctx.beginPath()
  ctx.arc(m.x + size / 2, m.y + size / 2, size / 2, 0, Math.PI * 2)
  ctx.clip()
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#000'
  ctx.fillRect(m.x, m.y, size, size)
  ctx.drawImage(source, cursor.x - half, cursor.y - half, MAG_PIXELS, MAG_PIXELS, m.x, m.y, size, size)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 1; i < MAG_PIXELS; i++) {
    ctx.moveTo(Math.round(m.x + i * cell) + 0.5, m.y)
    ctx.lineTo(Math.round(m.x + i * cell) + 0.5, m.y + size)
    ctx.moveTo(m.x, Math.round(m.y + i * cell) + 0.5)
    ctx.lineTo(m.x + size, Math.round(m.y + i * cell) + 0.5)
  }
  ctx.stroke()
  ctx.lineWidth = line
  ctx.strokeStyle = '#000'
  ctx.strokeRect(m.x + half * cell, m.y + half * cell, cell, cell)
  ctx.strokeStyle = '#fff'
  ctx.strokeRect(m.x + half * cell + line, m.y + half * cell + line, cell - 2 * line, cell - 2 * line)
  ctx.restore()
  ctx.beginPath()
  ctx.arc(m.x + size / 2, m.y + size / 2, size / 2, 0, Math.PI * 2)
  ctx.lineWidth = 2 * k
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
  ctx.stroke()
  const coords = `X: ${cursor.x}  Y: ${cursor.y}`
  ctx.font = `500 ${12 * k}px ${FONT}`
  label(coords, m.x + size / 2 - (ctx.measureText(coords).width + 14 * k) / 2, m.y + size + 6 * k)
}

function loop(): void {
  draw()
  if (!finished) requestAnimationFrame(loop)
}

function moveTo(clientX: number, clientY: number): void {
  if (!frame) return
  cursor.x = Math.max(0, Math.min(frame.width - 1, Math.floor(clientX * k)))
  cursor.y = Math.max(0, Math.min(frame.height - 1, Math.floor(clientY * k)))
  if (down && !dragging && Math.hypot(cursor.x - down.x, cursor.y - down.y) >= DRAG_THRESHOLD * k) {
    dragging = true
    hint.classList.add('gone')
  }
}

canvas.addEventListener('pointerenter', () => {
  inside = true
  window.glossCapture.enter()
})

canvas.addEventListener('pointerleave', () => {
  if (!dragging) inside = false
})

canvas.addEventListener('pointermove', (e) => {
  square = e.shiftKey
  inside = true
  moveTo(e.clientX, e.clientY)
})

canvas.addEventListener('pointerdown', (e) => {
  if (!frame) return
  moveTo(e.clientX, e.clientY)
  if (e.button === 0) {
    canvas.setPointerCapture(e.pointerId)
    down = { ...cursor }
    dragging = false
  } else if (e.button === 2) {
    // Right-click drops the region being drawn, or cancels when there is none.
    if (dragging) {
      dragging = false
      down = null
    } else finish(null)
  }
})

canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !down || !frame) return
  moveTo(e.clientX, e.clientY)
  if (dragging) {
    const rect = dragRect(down, cursor, square, frame.width, frame.height)
    dragging = false
    down = null
    if (rect.width >= MIN_REGION && rect.height >= MIN_REGION) finish({ rect, kind: 'region' })
    return
  }
  down = null
  finish(active())
})

canvas.addEventListener('contextmenu', (e) => e.preventDefault())

window.addEventListener('keydown', (e) => {
  square = e.shiftKey
  if (!frame) return
  if (e.key === 'Escape') finish(null)
  else if (e.key === ' ') {
    e.preventDefault()
    finish({ rect: displayRect(), kind: 'display' })
  } else if (e.key.startsWith('Arrow') && inside) {
    // Nudges the cursor a pixel (Shift: 10), for exact edges.
    e.preventDefault()
    const step = e.shiftKey ? 10 : 1
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
    moveTo((cursor.x + dx) / k, (cursor.y + dy) / k)
  }
})
window.addEventListener('keyup', (e) => {
  square = e.shiftKey
})

async function start(): Promise<void> {
  frame = await window.glossCapture.frame()
  // Measured, not the display's scale: the page shares Gloss's zoom (Ctrl+=), which makes CSS pixels larger.
  k = frame.width / (canvas.clientWidth || frame.width / frame.scale)
  const bitmap = await createImageBitmap(new Blob([frame.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
  for (const c of [frameCanvas, canvas]) {
    c.width = frame.width
    c.height = frame.height
  }
  frameCanvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  source = frameCanvas
  // The hint shows on the display the cursor is on.
  if (frame.cursor) {
    cursor.x = Math.max(0, Math.min(frame.width - 1, frame.cursor.x))
    cursor.y = Math.max(0, Math.min(frame.height - 1, frame.cursor.y))
    inside = true
    if (frame.windows.length === 0) document.getElementById('hint-window')!.remove()
    hint.hidden = false
  }
  loop()
}

start().catch(() => finish(null))
