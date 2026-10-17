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
