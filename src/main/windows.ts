// The windows on screen, for capture's hover-and-click (SPEC → Visual feedback). Electron
// has no API for other programs' windows; on Windows, koffi calls user32 and dwmapi.
// Elsewhere there are none, and the overlay offers a region or the whole display.
import type { CaptureRect, CaptureWindow } from '../shared/capture'

/** A window as Windows reports it: its frame in physical screen pixels, topmost first. */
export type ScreenWindow = { title: string; left: number; top: number; right: number; bottom: number }

const GW_HWNDNEXT = 2
const GWL_EXSTYLE = -20
/** Clicks go through it: overlays that aren't really there. */
const WS_EX_TRANSPARENT = 0x20
const DWMWA_EXTENDED_FRAME_BOUNDS = 9
const DWMWA_CLOAKED = 14
/** The desktop's own windows: over the desktop, a click takes the whole display. */
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW'])

type User32 = {
  top(parent: null): unknown
  next(hwnd: unknown): unknown
  visible(hwnd: unknown): boolean
  iconic(hwnd: unknown): boolean
  exStyle(hwnd: unknown): number
  text(hwnd: unknown, buf: Buffer, max: number): number
  className(hwnd: unknown, buf: Buffer, max: number): number
  bounds(hwnd: unknown, attr: number, out: { left: number; top: number; right: number; bottom: number }, size: number): number
  cloaked(hwnd: unknown, attr: number, out: number[], size: number): number
}

let api: User32 | null | undefined

async function load(): Promise<User32 | null> {
  if (api !== undefined) return api
  try {
    const koffi = await import('koffi')
    const user32 = koffi.load('user32.dll')
    const dwm = koffi.load('dwmapi.dll')
    koffi.struct('GLOSS_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
    const getWindow = user32.func('void * __stdcall GetWindow(void *hWnd, uint32_t uCmd)') as (h: unknown, cmd: number) => unknown
    const getLong = user32.func('long __stdcall GetWindowLongW(void *hWnd, int nIndex)') as (h: unknown, index: number) => number
    api = {
      top: user32.func('void * __stdcall GetTopWindow(void *hWnd)'),
      next: (hwnd) => getWindow(hwnd, GW_HWNDNEXT),
      visible: user32.func('bool __stdcall IsWindowVisible(void *hWnd)'),
      iconic: user32.func('bool __stdcall IsIconic(void *hWnd)'),
      exStyle: (hwnd) => getLong(hwnd, GWL_EXSTYLE),
      text: user32.func('int __stdcall GetWindowTextW(void *hWnd, void *lpString, int nMaxCount)'),
      className: user32.func('int __stdcall GetClassNameW(void *hWnd, void *lpClassName, int nMaxCount)'),
      bounds: dwm.func('long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ GLOSS_RECT *pvAttribute, uint32_t cbAttribute)'),
      cloaked: dwm.func('long __stdcall DwmGetWindowAttribute(void *hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)')
    } as User32
  } catch {
    api = null
  }
  return api
}

function utf16(read: (buf: Buffer, max: number) => number): string {
  const buf = Buffer.alloc(512)
  const n = read(buf, 256)
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''
}

/**
 * The visible top-level windows, topmost first, with their frames as drawn (DWM's extended
 * frame bounds, without the invisible resize borders). Empty off Windows or if it fails.
 */
export async function listWindows(platform = process.platform): Promise<ScreenWindow[]> {
  if (platform !== 'win32') return []
  const u = await load()
  if (!u) return []
  const out: ScreenWindow[] = []
  try {
    // Thousands at most; the guard stops a pathological loop.
    for (let hwnd = u.top(null), n = 0; hwnd && n < 5000; hwnd = u.next(hwnd), n++) {
      if (!u.visible(hwnd) || u.iconic(hwnd) || u.exStyle(hwnd) & WS_EX_TRANSPARENT) continue
      const cloaked = [0]
      if (u.cloaked(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0] !== 0) continue
      const rect = { left: 0, top: 0, right: 0, bottom: 0 }
      if (u.bounds(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) !== 0) continue
      if (rect.right - rect.left <= 1 || rect.bottom - rect.top <= 1) continue
      if (DESKTOP_CLASSES.has(utf16((b, m) => u.className(hwnd, b, m)))) continue
      out.push({ title: utf16((b, m) => u.text(hwnd, b, m)), ...rect })
    }
  } catch {
    return []
  }
  return out
}

/**
 * The windows that show on a display, in its pixels (`display` is its physical rectangle on
 * the screen), clipped to it. Windows entirely under ones above them are left out.
 */
export function windowsOn(windows: ScreenWindow[], display: CaptureRect): CaptureWindow[] {
  const out: CaptureWindow[] = []
  for (const w of windows) {
    const left = Math.max(w.left, display.x)
    const top = Math.max(w.top, display.y)
    const right = Math.min(w.right, display.x + display.width)
    const bottom = Math.min(w.bottom, display.y + display.height)
    if (right - left < 2 || bottom - top < 2) continue
    const rect = { x: left - display.x, y: top - display.y, width: right - left, height: bottom - top }
    if (out.some((above) => contains(above.rect, rect))) continue
    out.push({ title: w.title.trim(), rect })
  }
  return out
}

function contains(a: CaptureRect, b: CaptureRect): boolean {
  return a.x <= b.x && a.y <= b.y && a.x + a.width >= b.x + b.width && a.y + a.height >= b.y + b.height
}
