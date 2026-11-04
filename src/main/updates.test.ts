import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { updateError, Updates, type Updater } from './updates'

function fakeUpdater(check: () => Promise<unknown> = async () => ({})) {
  const events = new EventEmitter()
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(check),
    quitAndInstall: vi.fn(),
    on: (event: string, listener: (...args: unknown[]) => void) => events.on(event, listener)
  }
  return { updater: updater as typeof updater & Updater, events }
}

afterEach(() => { vi.useRealTimers() })

describe('Updates', () => {
  it('stays unsupported in development builds and on macOS', async () => {
    const dev = new Updates('1.0.0', null, vi.fn(), 'dev')
    expect(dev.state).toEqual({ version: '1.0.0', status: 'unsupported', reason: 'dev' })
    expect(await dev.check()).toEqual(dev.state)
    const { updater } = fakeUpdater()
    expect(new Updates('1.0.0', updater, vi.fn(), 'mac').state.reason).toBe('mac')
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('downloads an update in the background and installs it silently, then relaunches', async () => {
    const { updater, events } = fakeUpdater()
    const emit = vi.fn()
    const updates = new Updates('1.0.0', updater, emit, undefined, () => 1000)
    expect(updater.autoDownload && updater.autoInstallOnAppQuit).toBe(true)
    await updates.check()
    expect(updates.state.status).toBe('checking')
    events.emit('update-available', { version: '1.2.0' })
    events.emit('download-progress', { percent: 40.4 })
    expect(updates.state).toEqual({ version: '1.0.0', status: 'downloading', next: '1.2.0', percent: 40 })
    events.emit('update-downloaded', { version: '1.2.0' })
    expect(updates.state).toEqual({ version: '1.0.0', status: 'ready', next: '1.2.0', checkedAt: 1000 })
    expect(emit).toHaveBeenLastCalledWith(updates.state)
    // Nothing to check while one waits to install.
    await updates.check()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    updates.install()
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('reports a failed check the user started, in plain words, and keeps background failures quiet', async () => {
    const { updater, events } = fakeUpdater(async () => { throw new Error('net::ERR_INTERNET_DISCONNECTED https://api.github.com/...') })
    const updates = new Updates('1.0.0', updater, vi.fn(), undefined, () => 5)
    await updates.check(false)
    expect(updates.state).toEqual({ version: '1.0.0', status: 'idle', checkedAt: undefined })
    events.emit('update-not-available', { version: '1.0.0' })
    expect(updates.state.status).toBe('current')
    await updates.check()
    // The same failure through the error event doesn't replace the message.
    events.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    expect(updates.state).toEqual({ version: '1.0.0', status: 'error', error: "Couldn't check for updates: no internet connection.", checkedAt: 5 })
    expect(updateError(new Error('HttpError: 404 https://github.com/x?token=secret'))).toBe("Couldn't update Gloss. Try again later.")
  })

  it('checks shortly after launch and every few hours only while automatic', () => {
    vi.useFakeTimers()
    const { updater, events } = fakeUpdater()
    updater.checkForUpdates.mockImplementation(async () => events.emit('update-not-available', { version: '1.0.0' }))
    const updates = new Updates('1.0.0', updater, vi.fn())
    updates.setAutomatic(true)
    vi.advanceTimersByTime(10_000)
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(4 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
    updates.setAutomatic(false)
    vi.advanceTimersByTime(5 * 60 * 60 * 1000)
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})
