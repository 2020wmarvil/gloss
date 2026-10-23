// Screen capture for visual feedback (SPEC → Visual feedback). Freezes every display and opens
// the region overlay over each: drag a region, click a window, or Space for the display under
// the cursor, as in ShareX. A region stays on one display. Gloss doesn't hide first, so it is
// part of the capture.
import { BrowserWindow, desktopCapturer, ipcMain, screen, type Display, type NativeImage } from 'electron'
import { CAPTURE_IPC, type Capture, type CaptureChoice, type CaptureFrame, type CaptureRect } from '../shared/capture'
import { takeForeground } from './foreground'
import { listWindows, windowsOn, type ScreenWindow } from './windows'

type Overlay = { win: BrowserWindow; display: Display; image: NativeImage; frame: CaptureFrame }

type Pending = {
  overlays: Overlay[]
  onPicked?(): void
  resolve(capture: Capture | null): void
}

let pending: Pending | null = null

export type CaptureOptions = {
  /** The overlay's preload script. */
  preload: string
  /** Loads the overlay's page into a window. */
  load(win: BrowserWindow): void
  /** Called once something is picked, while an overlay still has the focus (to bring Gloss forward). */
  onPicked?(): void
}

/**
 * Captures every display and lets the user pick what to keep. Resolves to the picked part as a
 * PNG, or null if they cancel. One at a time: a second call while the overlays are open brings
 * the one under the cursor to the front and resolves to null.
 */
export async function startCapture(options: CaptureOptions): Promise<Capture | null> {
  if (pending) {
    overlayUnderCursor(pending)?.win.focus()
    return null
  }
  const displays = screen.getAllDisplays()
  const images = await grab(displays)
  const shown = displays.filter((d) => images.has(d.id))
  if (shown.length === 0) throw new Error("Couldn't capture the screen.")
  const windows = await listWindows()
  const cursor = screen.getCursorScreenPoint()
  const active = screen.getDisplayNearestPoint(cursor)

  const overlays = shown.map((display): Overlay => {
    const image = images.get(display.id)!
    const frame = frameOf(display, image, windows, display.id === active.id ? cursor : null)
    return { win: overlayWindow(display, options.preload), display, image, frame }
  })

  return new Promise<Capture | null>((resolve) => {
    pending = { overlays, onPicked: options.onPicked, resolve }
    for (const o of overlays) {
      o.win.once('ready-to-show', () => {
        o.win.showInactive()
        // A display scaled differently from the one the window started on can size it wrong.
        o.win.setBounds(o.display.bounds)
        // The cursor's display takes the keys first. Started from another app (the global
        // shortcut), Windows won't hand Gloss the focus on its own.
        if (o.display.id === active.id) {
          o.win.focus()
          if (!o.win.isFocused()) void takeForeground(o.win.getNativeWindowHandle())
        }
      })
      o.win.on('closed', () => finish(null))
      options.load(o.win)
    }
  })
}

/** Each display's picture, at its own pixels. desktopCapturer scales every screen to one size, so it is asked once per size. */
async function grab(displays: Display[]): Promise<Map<number, NativeImage>> {
  const bySize = new Map<string, Display[]>()
  for (const d of displays) {
    const size = physicalSize(d)
    const key = `${size.width}x${size.height}`
    bySize.set(key, [...(bySize.get(key) ?? []), d])
  }
  const images = new Map<number, NativeImage>()
  for (const group of bySize.values()) {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physicalSize(group[0]) })
    for (const d of group) {
      // Some platforms leave display_id empty: with one display and one screen they match.
      const source = sources.find((s) => s.display_id === String(d.id)) ?? (displays.length === 1 && sources.length === 1 ? sources[0] : undefined)
      if (source && !source.thumbnail.isEmpty()) images.set(d.id, source.thumbnail)
    }
  }
  return images
}

function physicalSize(d: Display): { width: number; height: number } {
  return { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) }
}

/** What one overlay draws: its display's picture, the windows on it, and the cursor if it is there. */
function frameOf(display: Display, image: NativeImage, windows: ScreenWindow[], cursor: Electron.Point | null): CaptureFrame {
  const { width, height } = image.getSize()
  // Window frames come in physical screen pixels; the display's place among them too.
  const physical = process.platform === 'win32' ? screen.dipToScreenRect(null, display.bounds) : scaleRect(display.bounds, display.scaleFactor)
  const toImage = width / physical.width
  const scale = width / display.bounds.width
  return {
    png: new Uint8Array(image.toPNG()),
    width,
    height,
    scale,
    windows: windowsOn(windows, physical).map((w) => ({ title: w.title, rect: scaleRect(w.rect, toImage) })),
    ...(cursor ? { cursor: { x: Math.round((cursor.x - display.bounds.x) * scale), y: Math.round((cursor.y - display.bounds.y) * scale) } } : {})
  }
}

function overlayWindow(display: Display, preload: string): BrowserWindow {
  const win = new BrowserWindow({
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
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  return win
}

function overlayUnderCursor(p: Pending): Overlay | undefined {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return p.overlays.find((o) => o.display.id === display.id) ?? p.overlays[0]
}

function finish(capture: Capture | null): void {
  const p = pending
  if (!p) return
  pending = null
  if (capture) p.onPicked?.()
  p.resolve(capture)
  for (const o of p.overlays) if (!o.win.isDestroyed()) o.win.destroy()
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

/** The overlays' calls; only an open overlay may make them. */
export function registerCaptureIpc(): void {
  const overlayOf = (sender: Electron.WebContents): Overlay | undefined => pending?.overlays.find((o) => o.win.webContents === sender)
  ipcMain.handle(CAPTURE_IPC.frame, (e) => {
    const o = overlayOf(e.sender)
    if (!o) throw new Error('No capture is open.')
    return o.frame
  })
  // The cursor moved onto this display: it takes the keys.
  ipcMain.on(CAPTURE_IPC.enter, (e) => {
    const o = overlayOf(e.sender)
    if (o && !o.win.isFocused()) o.win.focus()
  })
  ipcMain.handle(CAPTURE_IPC.done, (e, value: unknown) => {
    const from = overlayOf(e.sender)
    if (!pending || !from) return
    const choice = value as CaptureChoice
    const kind = choice?.kind
    if (!choice || (kind !== 'region' && kind !== 'window' && kind !== 'display')) return finish(null)
    // Space (or a click on the desktop) takes the whole display under the cursor, whichever overlay has the keys.
    const o = kind === 'display' ? (overlayUnderCursor(pending) ?? from) : from
    const rect = kind === 'display' ? { x: 0, y: 0, width: o.frame.width, height: o.frame.height } : choiceRect(choice.rect, o.frame.width, o.frame.height)
    if (!rect) return finish(null)
    const title = typeof choice.title === 'string' ? choice.title.slice(0, 200) : undefined
    const png = o.image.crop(rect).toPNG()
    finish({ data: png.toString('base64'), width: rect.width, height: rect.height, source: sourceLabel({ kind, rect, title }) })
  })
}
