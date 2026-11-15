import { beforeEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  packaged: true,
  trays: [] as { destroyed: boolean; click?: () => void; menu: { label?: string; click?: () => void }[] }[],
  blockers: [] as string[],
  stopped: [] as number[],
  login: [] as { openAtLogin: boolean; args: string[] }[]
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return mocked.packaged },
    setLoginItemSettings: (s: { openAtLogin: boolean; args: string[] }) => mocked.login.push(s),
    getLoginItemSettings: () => ({ wasOpenedAtLogin: false })
  },
  Menu: { buildFromTemplate: (items: unknown[]) => items },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  powerSaveBlocker: {
    start: (type: string) => mocked.blockers.push(type) - 1,
    stop: (id: number) => mocked.stopped.push(id)
  },
  Tray: class {
    entry = { destroyed: false, menu: [] as { label?: string; click?: () => void }[], click: undefined as undefined | (() => void) }
    constructor() { mocked.trays.push(this.entry) }
    setToolTip(): void {}
    setContextMenu(menu: { label?: string; click?: () => void }[]): void { this.entry.menu = menu }
    on(_event: string, handler: () => void): void { this.entry.click = handler }
    destroy(): void { this.entry.destroyed = true }
  }
}))

const { Background, startedAtLogin } = await import('./background')

beforeEach(() => {
  mocked.packaged = true
  mocked.trays.length = 0
  mocked.blockers.length = 0
  mocked.stopped.length = 0
  mocked.login.length = 0
})

const off = { closeToTray: false, startAtLogin: false, keepAwake: false }

it('shows a tray icon only while closeToTray is on, with Open and Quit', () => {
  const open = vi.fn()
  const quit = vi.fn()
  const bg = new Background({ icon: 'icon.ico', open, quit })
  bg.apply({ ...off, closeToTray: true })
  bg.apply({ ...off, closeToTray: true })
  expect(mocked.trays).toHaveLength(1)
  mocked.trays[0].menu.find((m) => m.label === 'Quit Gloss')!.click!()
  expect(quit).toHaveBeenCalled()
  if (process.platform !== 'darwin') {
    mocked.trays[0].click!()
    expect(open).toHaveBeenCalled()
  }
  bg.apply(off)
  expect(mocked.trays[0].destroyed).toBe(true)
})

it('blocks system sleep, not the display, while keepAwake is on', () => {
  const bg = new Background({ icon: 'i', open() {}, quit() {} })
  bg.apply({ ...off, keepAwake: true })
  bg.apply({ ...off, keepAwake: true })
  expect(mocked.blockers).toEqual(['prevent-app-suspension'])
  bg.apply(off)
  expect(mocked.stopped).toEqual([0])
})

it('registers the login item with the hidden argument only when installed, and only on a change', () => {
  const bg = new Background({ icon: 'i', open() {}, quit() {} })
  bg.apply({ ...off, startAtLogin: true })
  bg.apply({ ...off, startAtLogin: true, keepAwake: true })
  bg.apply(off)
  if (process.platform === 'win32' || process.platform === 'darwin') {
    expect(mocked.login).toEqual([{ openAtLogin: true, args: ['--hidden'] }, { openAtLogin: false, args: ['--hidden'] }])
  }
  mocked.packaged = false
  mocked.login.length = 0
  new Background({ icon: 'i', open() {}, quit() {} }).apply({ ...off, startAtLogin: true })
  expect(mocked.login).toEqual([])
})

it('knows a launch at sign-in by its argument', () => {
  expect(startedAtLogin(['gloss.exe', '--hidden'])).toBe(true)
  expect(startedAtLogin(['gloss.exe'])).toBe(false)
})
