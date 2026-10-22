// Screen capture for visual feedback (SPEC → Visual feedback). Freezes the display under the
// cursor and opens the region overlay over it: drag a region, click a window, or Space for the
// whole display, as in ShareX. Gloss doesn't hide first, so it is part of the capture.
import { BrowserWindow, desktopCapturer, ipcMain, screen, type NativeImage } from 'electron'
import { CAPTURE_IPC, type Capture, type CaptureChoice, type CaptureFrame, type CaptureRect } from '../shared/capture'
import { listWindows, windowsOn } from './windows'

type Pending = {
  overlay: BrowserWindow
  image: NativeImage
  frame: CaptureFrame
  resolve(capture: Capture | null): void
}

let pending: Pending | null = null

export type OverlayLoader = (win: BrowserWindow) => void

/**
 * Captures the display under the cursor and lets the user pick what to keep. Resolves to the
 * picked part as a PNG, or null if they cancel. One at a time: a second call while the overlay
 * is open brings it back to the front and resolves to null.
 */
export async function startCapture(preload: string, load: OverlayLoader): Promise<Capture | null> {
  if (pending) {
    pending.overlay.focus()
    return null
  }
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const size = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor)
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source || source.thumbnail.isEmpty()) throw new Error("Couldn't capture the screen.")
  const image = source.thumbnail
  const { width, height } = image.getSize()

  // Window frames come in physical screen pixels; the display's place among them too.
  const physical = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : scaleRect(display.bounds, display.scaleFactor)
  const toImage = width / physical.width
  const windows = windowsOn(await listWindows(), physical).map((w) => ({ title: w.title, rect: scaleRect(w.rect, toImage) }))
  const frame: CaptureFrame = { png: new Uint8Array(image.toPNG()), width, height, scale: width / display.bounds.width, windows }

  const overlay = new BrowserWindow({
    ...display.bounds,
    title: 'Gloss capture',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    show: false,
    backgroundColor: '#000000',
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  // Over the taskbar and other always-on-top windows, as ShareX's is.
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  overlay.webContents.on('will-navigate', (event) => event.preventDefault())

  return new Promise<Capture | null>((resolve) => {
    pending = { overlay, image, frame, resolve }
    overlay.once('ready-to-show', () => {
      overlay.show()
      // A display scaled differently from the one the window started on can size it wrong.
      overlay.setBounds(display.bounds)
      overlay.focus()
    })
    overlay.on('closed', () => finish(null))
    load(overlay)
  })
}

function finish(capture: Capture | null): void {
  const p = pending
  if (!p) return
  pending = null
  p.resolve(capture)
  if (!p.overlay.isDestroyed()) p.overlay.destroy()
}

function scaleRect(r: { x: number; y: number; width: number; height: number }, k: number): CaptureRect {
  return { x: Math.round(r.x * k), y: Math.round(r.y * k), width: Math.round(r.width * k), height: Math.round(r.height * k) }
}

/** The picked rectangle, clipped to the image; null if it isn't one. */
export function choiceRect(value: unknown, width: number, height: number): CaptureRect | null {
  const r = value as Partial<Record<string, unknown>> | null
  if (!r || ![r.x, r.y, r.width, r.height].every((n) => Number.isFinite(n))) return null
  const x = Math.max(0, Math.floor(r.x as number))
  const y = Math.max(0, Math.floor(r.y as number))
  const right = Math.min(width, Math.ceil((r.x as number) + (r.width as number)))
  const bottom = Math.min(height, Math.ceil((r.y as number) + (r.height as number)))
  return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null
}

/** What the canvas's header says was captured. */
export function sourceLabel(choice: NonNullable<CaptureChoice>): string {
  if (choice.kind === 'display') return 'Display'
  if (choice.kind === 'window') return choice.title ? `Window: ${choice.title}` : 'Window'
  return 'Region'
}

/** The overlay's calls; only the open overlay may make them. */
export function registerCaptureIpc(): void {
  ipcMain.handle(CAPTURE_IPC.frame, (e) => {
    if (!pending || e.sender !== pending.overlay.webContents) throw new Error('No capture is open.')
    return pending.frame
  })
  ipcMain.handle(CAPTURE_IPC.done, (e, value: unknown) => {
    if (!pending || e.sender !== pending.overlay.webContents) return
    const choice = value as CaptureChoice
    const kind = choice?.kind
    const rect = choice && (kind === 'region' || kind === 'window' || kind === 'display') ? choiceRect(choice.rect, pending.frame.width, pending.frame.height) : null
    if (!choice || !rect) return finish(null)
    const title = typeof choice.title === 'string' ? choice.title.slice(0, 200) : undefined
    const png = pending.image.crop(rect).toPNG()
    finish({ data: png.toString('base64'), width: rect.width, height: rect.height, source: sourceLabel({ kind: kind!, rect, title }) })
  })
}
