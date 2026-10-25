import { expect, it, vi } from 'vitest'
import { createCloseGuard } from './closeGuard'

it('closes without a dialog when idle', () => {
  const confirm = vi.fn()
  const guard = createCloseGuard({ isWorking: () => false, confirm })
  const event = { preventDefault: vi.fn() }
  expect(guard(event, vi.fn())).toBe(true)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(confirm).not.toHaveBeenCalled()
})

it('keeps work alive on dismissal and asks again on the next close', async () => {
  const confirm = vi.fn(async () => false)
  const guard = createCloseGuard({ isWorking: () => true, confirm })
  const event = { preventDefault: vi.fn() }
  const close = vi.fn()
  expect(guard(event, close)).toBe(false)
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
  expect(close).not.toHaveBeenCalled()
  expect(event.preventDefault).toHaveBeenCalledOnce()
  await new Promise((resolve) => setTimeout(resolve, 0))
  guard(event, close)
  expect(confirm).toHaveBeenCalledTimes(2)
})

it('shares pending confirmation and permits the confirmed close and quit', async () => {
  let answer!: (close: boolean) => void
  const confirm = vi.fn(() => new Promise<boolean>((resolve) => { answer = resolve }))
  const guard = createCloseGuard({ isWorking: () => true, confirm })
  const event = { preventDefault: vi.fn() }
  const close = vi.fn()
  guard(event, close)
  guard(event, vi.fn())
  expect(confirm).toHaveBeenCalledOnce()
  answer(true)
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(guard(event, close)).toBe(true)
  expect(confirm).toHaveBeenCalledOnce()
})

it('keeps work alive if the dialog fails', async () => {
  const guard = createCloseGuard({ isWorking: () => true, confirm: async () => { throw new Error('dialog failed') } })
  const close = vi.fn()
  guard({ preventDefault() {} }, close)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(close).not.toHaveBeenCalled()
})
