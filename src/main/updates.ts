// Gloss's own updates from GitHub Releases (SPEC → Shipping), through electron-updater.
import type { UpdateState } from '../shared/ipc'

const FIRST_CHECK_MS = 10_000
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/** The part of electron-updater's AppUpdater Gloss uses. */
export type Updater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

/** What the user sees for a failure: never the raw error, which can carry URLs and headers. */
export function updateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/.test(message)
    ? "Couldn't check for updates: no internet connection."
    : "Couldn't update Gloss. Try again later."
}

export class Updates {
  private current: UpdateState
  /** A failure is shown only for a check the user started. */
  private manual = false
  private timers: ReturnType<typeof setTimeout>[] = []

  constructor(
    version: string,
    private readonly updater: Updater | null,
    private readonly emit: (state: UpdateState) => void,
    unsupported?: 'dev' | 'mac',
    private readonly now = Date.now
  ) {
    this.current = unsupported || !updater ? { version, status: 'unsupported', reason: unsupported ?? 'dev' } : { version, status: 'idle' }
    if (!updater || unsupported) return
    updater.autoDownload = true
    // An update nobody restarted for installs when Gloss quits.
    updater.autoInstallOnAppQuit = true
    updater.on('update-available', (info) => this.set({ status: 'downloading', next: info.version, percent: 0 }))
    updater.on('download-progress', (progress) => {
      if (this.current.status === 'downloading') this.set({ ...this.current, percent: Math.round(progress.percent) })
    })
    updater.on('update-downloaded', (info) => { this.manual = false; this.set({ status: 'ready', next: info.version, checkedAt: this.now() }) })
    updater.on('update-not-available', () => { this.manual = false; this.set({ status: 'current', checkedAt: this.now() }) })
    updater.on('error', (error) => this.fail(error))
  }

  get state(): UpdateState {
    return this.current
  }

  /** Checks shortly after launch and then every few hours while `auto` is on. */
  setAutomatic(auto: boolean): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    if (!auto || this.current.status === 'unsupported') return
    const first = setTimeout(() => void this.check(false), FIRST_CHECK_MS)
    const every = setInterval(() => void this.check(false), CHECK_EVERY_MS)
    first.unref?.()
    every.unref?.()
    this.timers.push(first, every)
  }

  async check(manual = true): Promise<UpdateState> {
    const { status } = this.current
    if (!this.updater || status === 'unsupported' || status === 'checking' || status === 'downloading' || status === 'ready') return this.current
    this.manual = manual
    this.set({ status: 'checking', checkedAt: this.current.checkedAt })
    try {
      await this.updater.checkForUpdates()
    } catch (error) {
      this.fail(error)
    }
    return this.current
  }

  /** Quits and runs the downloaded installer, which starts Gloss again. */
  install(): void {
    if (this.current.status === 'ready') this.updater?.quitAndInstall(true, true)
  }

  dispose(): void {
    this.setAutomatic(false)
  }

  private fail(error: unknown): void {
    // A failed check can report through both its promise and the error event.
    if (this.current.status === 'ready' || this.current.status === 'error') return
    if (this.manual) this.set({ status: 'error', error: updateError(error), checkedAt: this.current.checkedAt })
    // A background check that fails stays quiet; the next one tries again.
    else this.set({ status: this.current.checkedAt ? 'current' : 'idle', checkedAt: this.current.checkedAt })
    this.manual = false
  }

  private set(next: Omit<UpdateState, 'version'>): void {
    this.current = { version: this.current.version, ...next }
    this.emit(this.current)
  }
}
