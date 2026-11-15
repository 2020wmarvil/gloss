// Keeping Gloss running without a window (SPEC → Session windows → Closing the main window):
// the tray icon, starting at sign-in and the keep-awake blocker. Each follows its setting.
import { app, Menu, nativeImage, powerSaveBlocker, Tray } from 'electron'

export type BackgroundSettings = { closeToTray: boolean; startAtLogin: boolean; keepAwake: boolean }

/** The argument Gloss is started with at sign-in, so it opens in the tray. */
export const HIDDEN_ARG = '--hidden'

/** Whether this launch was the one at sign-in. */
export function startedAtLogin(argv: readonly string[]): boolean {
  if (argv.includes(HIDDEN_ARG)) return true
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin
}

export class Background {
  private tray: Tray | null = null
  private blocker: number | null = null
  private loginItem: boolean | null = null

  constructor(private readonly opts: { icon: string; open(): void; quit(): void }) {}

  apply(s: BackgroundSettings): void {
    if (s.closeToTray && !this.tray) this.tray = this.createTray()
    else if (!s.closeToTray && this.tray) {
      this.tray.destroy()
      this.tray = null
    }

    if (s.keepAwake && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!s.keepAwake && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }

    // A development build would register the bare Electron binary, so only installed copies do.
    if (app.isPackaged && (process.platform === 'win32' || process.platform === 'darwin') && this.loginItem !== s.startAtLogin) {
      this.loginItem = s.startAtLogin
      app.setLoginItemSettings({ openAtLogin: s.startAtLogin, args: [HIDDEN_ARG] })
    }
  }

  dispose(): void {
    this.tray?.destroy()
    this.tray = null
    if (this.blocker !== null) powerSaveBlocker.stop(this.blocker)
    this.blocker = null
  }

  private createTray(): Tray {
    const image = nativeImage.createFromPath(this.opts.icon)
    const tray = new Tray(process.platform === 'win32' ? image : image.resize({ width: 16, height: 16 }))
    tray.setToolTip('Gloss')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Gloss', click: () => this.opts.open() },
      { type: 'separator' },
      { label: 'Quit Gloss', click: () => this.opts.quit() }
    ]))
    // Windows and Linux open on a click; macOS shows the menu instead.
    if (process.platform !== 'darwin') tray.on('click', () => this.opts.open())
    return tray
  }
}
