// Lets the editor Gloss starts come to the front on Windows. Windows won't let a program
// bring its window forward while the user is using another one, so a running editor
// that is handed a file stays behind Gloss. The program in front (Gloss, just clicked)
// may allow it with AllowSetForegroundWindow, which Electron has no API for: koffi
// calls it in user32.dll.

/** Any process may take the foreground once (ASFW_ANY). */
const ASFW_ANY = 0xffffffff

let allow: ((pid: number) => boolean) | null | undefined

/**
 * Allows the next window that asks to come to the front. Does nothing off Windows, and
 * if the call isn't available the editor just opens behind Gloss.
 */
export async function allowForeground(platform = process.platform): Promise<void> {
  if (platform !== 'win32' || allow === null) return
  try {
    if (allow === undefined) {
      const koffi = await import('koffi')
      allow = koffi.load('user32.dll').func('bool __stdcall AllowSetForegroundWindow(uint32_t dwProcessId)') as (pid: number) => boolean
    }
    allow(ASFW_ANY)
  } catch {
    allow = null
  }
}

type Steal = {
  foreground(): number
  threadOf(hwnd: number, pid: null): number
  currentThread(): number
  attach(from: number, to: number, on: boolean): boolean
  setForeground(hwnd: number): boolean
  toTop(hwnd: number): boolean
}

let steal: Steal | null | undefined

/**
 * Brings a Gloss window to the front while another app has the focus: the capture overlay,
 * opened by the global shortcut (SPEC → Visual feedback). Windows refuses SetForegroundWindow
 * to a program in the background, unless its input thread is attached to the foreground
 * window's for the call. `handle` is `getNativeWindowHandle()`. Does nothing off Windows;
 * resolves to whether the window came forward.
 */
export async function takeForeground(handle: Buffer, platform = process.platform): Promise<boolean> {
  if (platform !== 'win32' || steal === null) return false
  try {
    if (steal === undefined) {
      const koffi = await import('koffi')
      const user32 = koffi.load('user32.dll')
      const kernel32 = koffi.load('kernel32.dll')
      steal = {
        foreground: user32.func('intptr_t __stdcall GetForegroundWindow()'),
        threadOf: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, void *lpdwProcessId)'),
        currentThread: kernel32.func('uint32_t __stdcall GetCurrentThreadId()'),
        attach: user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool fAttach)'),
        setForeground: user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'),
        toTop: user32.func('bool __stdcall BringWindowToTop(intptr_t hWnd)')
      } as Steal
    }
    const s = steal
    const hwnd = Number(handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0))
    const other = s.threadOf(s.foreground(), null)
    const mine = s.currentThread()
    const attached = other !== 0 && other !== mine && s.attach(mine, other, true)
    try {
      s.toTop(hwnd)
      return s.setForeground(hwnd)
    } finally {
      if (attached) s.attach(mine, other, false)
    }
  } catch {
    steal = null
    return false
  }
}
