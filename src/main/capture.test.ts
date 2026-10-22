import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, desktopCapturer: {}, ipcMain: {}, screen: {} }))

const { choiceRect, sourceLabel } = await import('./capture')
const { windowsOn } = await import('./windows')

it('clips a picked rectangle to the frame and rejects ones that are not', () => {
  expect(choiceRect({ x: 10.4, y: 20, width: 100, height: 50 }, 1920, 1080)).toEqual({ x: 10, y: 20, width: 101, height: 50 })
  expect(choiceRect({ x: -5, y: -5, width: 10, height: 10 }, 1920, 1080)).toEqual({ x: 0, y: 0, width: 5, height: 5 })
  expect(choiceRect({ x: 1900, y: 1000, width: 100, height: 100 }, 1920, 1080)).toEqual({ x: 1900, y: 1000, width: 20, height: 80 })
  expect(choiceRect({ x: 2000, y: 0, width: 10, height: 10 }, 1920, 1080)).toBeNull()
  expect(choiceRect({ x: 'a', y: 0, width: 10, height: 10 }, 1920, 1080)).toBeNull()
  expect(choiceRect(null, 1920, 1080)).toBeNull()
})

it('labels what was captured', () => {
  const rect = { x: 0, y: 0, width: 1, height: 1 }
  expect(sourceLabel({ kind: 'region', rect })).toBe('Region')
  expect(sourceLabel({ kind: 'display', rect })).toBe('Display')
  expect(sourceLabel({ kind: 'window', rect, title: 'cachekit – Chrome' })).toBe('Window: cachekit – Chrome')
  expect(sourceLabel({ kind: 'window', rect, title: '' })).toBe('Window')
})

it("puts windows in a display's pixels, clipped, leaving out ones hidden under others", () => {
  const display = { x: 2560, y: 0, width: 1920, height: 1080 }
  const windows = windowsOn(
    [
      { title: ' Editor ', left: 2600, top: 100, right: 3600, bottom: 900 },
      // Entirely under the editor.
      { title: 'Dialog', left: 2700, top: 200, right: 3000, bottom: 400 },
      // Mostly on the other display.
      { title: 'Spans', left: 2000, top: 0, right: 2660, bottom: 500 },
      { title: 'Elsewhere', left: 0, top: 0, right: 1000, bottom: 1000 },
      { title: 'Taskbar', left: 2560, top: 1032, right: 4480, bottom: 1080 }
    ],
    display
  )
  expect(windows).toEqual([
    { title: 'Editor', rect: { x: 40, y: 100, width: 1000, height: 800 } },
    { title: 'Spans', rect: { x: 0, y: 0, width: 100, height: 500 } },
    { title: 'Taskbar', rect: { x: 0, y: 1032, width: 1920, height: 48 } }
  ])
})
