import { access, writeFile } from 'node:fs/promises'
import type { WebContents } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import type { Store } from './db'

const mocked = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  launch: vi.fn()
}))
vi.mock('electron', () => ({
  app: { once: vi.fn() },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => mocked.handlers.set(name, handler) }
}))
vi.mock('./openFile', async (original) => ({ ...await original<typeof import('./openFile')>(), launchEditor: mocked.launch }))
import { registerComposerIpc } from './composerIpc'

beforeEach(() => { mocked.handlers.clear(); mocked.launch.mockReset() })

it('returns saved prompt text after the editor closes, cleans up, and returns focus to Gloss', async () => {
  const sender = {} as WebContents
  const focus = vi.fn()
  registerComposerIpc({} as Store, () => sender, () => 'code -g {file}:{line}', focus)
  let close!: () => void
  const closed = new Promise<void>((resolve) => { close = resolve })
  let path = ''
  mocked.launch.mockImplementation(async (args: string[], file: string, _platform: string, wait: boolean) => {
    path = file
    expect(args).toContain('--wait')
    expect(wait).toBe(true)
    await writeFile(file, 'edited prompt')
    await closed
  })
  const done = vi.fn()
  const pending = (mocked.handlers.get(IPC.composerEditDraft)!({ sender }, 'original prompt') as Promise<string>).then((text) => { done(text); return text })
  await vi.waitFor(() => expect(mocked.launch).toHaveBeenCalledOnce())
  expect(done).not.toHaveBeenCalled()
  expect(focus).not.toHaveBeenCalled()
  close()
  expect(await pending).toBe('edited prompt')
  expect(focus).toHaveBeenCalledOnce()
  await expect(access(path)).rejects.toThrow()
  mocked.launch.mockImplementation(async (_args: string[], file: string) => { await writeFile(file, 'second edit') })
  expect(await mocked.handlers.get(IPC.composerEditDraft)!({ sender }, 'another prompt')).toBe('second edit')
})
