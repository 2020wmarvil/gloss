// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { McpSettings } from './McpSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => act(() => root?.unmount()))

it('validates edits before saving and preserves the draft on errors', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('File is locked')).mockResolvedValue(undefined)
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<McpSettings servers={[]} onSave={save} />))
  const textarea = el.querySelector('textarea')!
  const edit = async (text: string): Promise<void> => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await edit('[{"name":"missing command"}]')
  await act(async () => el.querySelector('button')!.click())
  expect(save).not.toHaveBeenCalled()
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('command is required')
  const servers = [{ name: 'tools', command: '/tools/server', args: [], env: [] }]
  await edit(JSON.stringify(servers))
  await act(async () => el.querySelector('button')!.click())
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('File is locked')
  expect(textarea.value).toBe(JSON.stringify(servers))
  await act(async () => el.querySelector('button')!.click())
  expect(save).toHaveBeenLastCalledWith(servers)
  expect(el.querySelector('[role="alert"]')).toBeNull()
})
