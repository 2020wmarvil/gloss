import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
vi.mock('./foreground', () => ({ allowForeground: vi.fn().mockResolvedValue(undefined) }))
import { launchEditor } from './openFile'

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('keeps a prompt edit pending until the waiting launcher exits, beyond the normal launch timeout', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  mocked.spawn.mockReturnValue(child)
  const completed = vi.fn()
  const pending = launchEditor(['code', '--wait', '/tmp/prompt.md'], '/tmp/prompt.md', 'linux', true).then(completed)
  await vi.advanceTimersByTimeAsync(5000)
  expect(completed).not.toHaveBeenCalled()
  expect(child.unref).not.toHaveBeenCalled()
  child.emit('exit', 0)
  await pending
  expect(completed).toHaveBeenCalledOnce()
})

it('rejects a failed waiting editor so the composer can unlock and retry', async () => {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  mocked.spawn.mockReturnValue(child)
  const pending = launchEditor(['code', '--wait', '/tmp/prompt.md'], '/tmp/prompt.md', 'linux', true)
  const rejected = expect(pending).rejects.toThrow('failed with exit code 1')
  await Promise.resolve()
  child.emit('exit', 1)
  await rejected
})
