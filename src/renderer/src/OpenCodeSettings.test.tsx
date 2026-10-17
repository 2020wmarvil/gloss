// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenCodeSettings } from './OpenCodeSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()) })

it('saves setup only after successful ACP validation and reports a failed connection', async () => {
  const test = vi.fn()
    .mockResolvedValueOnce({ available: false, executable: null, version: null, error: 'Not found' })
    .mockResolvedValueOnce({ available: true, executable: '/bin/opencode', version: '2.0.32', error: null })
  window.gloss = { agents: { testOpenCode: test } } as unknown as typeof window.gloss
  const save = vi.fn(async () => {})
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<OpenCodeSettings executable="" onSave={save} />))
  await act(async () => el.querySelector('button')!.click())
  expect(el.querySelector('[role="alert"]')?.textContent).toBe('Not found')
  expect(save).not.toHaveBeenCalled()
  await act(async () => el.querySelector('button')!.click())
  expect(test).toHaveBeenCalledWith('')
  expect(save).toHaveBeenCalledWith('')
  expect(el.querySelector('[role="status"]')?.textContent).toContain('2.0.32')
})
