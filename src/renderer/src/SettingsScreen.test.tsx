// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsScreen } from './SettingsScreen'
import type { SettingsState } from '@shared/ipc'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()) })
const projects = ['gloss', 'website', 'notes'].map((name) => ({ name, path: `C:/projects/${name}`, where: 'C:/projects' }))
const state: SettingsState = {
  path: 'C:/data/settings.json', error: null,
  global: { defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', turnEndSound: true, permissionMode: 'bypass' as const, externalEditor: '', mcpServers: [] },
  projects: { 'C:/projects/website': { obsidianVault: 'Website notes' } }
}

it('lists every open project and writes overrides to the selected project without an active session', async () => {
  const update = vi.fn<(patch: import('@shared/ipc').SettingsPatch) => Promise<void>>(async () => {})
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<SettingsScreen state={state} projects={projects} projectPath={null}
    onUpdate={update} onOpenFile={async () => null} onClose={() => {}} />))
  const nav = (): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('.settings-nav button')]
  for (const p of projects) expect(nav().some((button) => button.textContent === p.name)).toBe(true)
  await act(async () => nav().find((button) => button.textContent === 'website')!.click())
  const input = el.querySelector<HTMLInputElement>('#setting-obsidianVault')!
  expect(input.value).toBe('Website notes')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Updated vault')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(update).toHaveBeenCalledWith({ project: { path: 'C:/projects/website', values: { obsidianVault: 'Updated vault' } } })
  await act(async () => nav().find((button) => button.textContent === 'notes')!.click())
  expect(el.querySelector<HTMLInputElement>('#setting-obsidianVault')!.value).toBe('')
  expect(nav().find((button) => button.getAttribute('aria-current') === 'page')?.textContent).toBe('notes')
})


it('records, clears and resets commands, and refuses a conflicting recording', async () => {
  const update = vi.fn<(patch: import('@shared/ipc').SettingsPatch) => Promise<void>>(async () => {})
  const close = vi.fn()
  const el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  const render = async (shortcuts: Record<string, string> = {}) => act(async () => root!.render(<SettingsScreen state={{ ...state, global: { ...state.global, shortcuts } }} projects={[]} projectPath={null} initialSection="shortcuts" onUpdate={update} onOpenFile={async () => null} onClose={close} />))
  await render()
  const record = async (id: string, key: string, extra = {}) => {
    const button = el.querySelector<HTMLButtonElement>(`#binding-${id}`)!
    await act(async () => button.click())
    await act(async () => button.dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...extra })))
  }
  await record('bold', 'i', { ctrlKey: true })
  expect(el.textContent).toContain('Already used by Italic')
  expect(update).not.toHaveBeenCalled()
  await record('bold', 'k', { ctrlKey: true, shiftKey: true })
  expect(update).toHaveBeenLastCalledWith({ global: { shortcuts: { bold: 'Mod+Shift+K' }, captureShortcut: 'Ctrl+Shift+PrintScreen' } })
  await render({ bold: 'Mod+Shift+K' })
  await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Clear Bold"]')!.click())
  expect(update.mock.lastCall).toEqual([{ global: { shortcuts: { bold: '' }, captureShortcut: 'Ctrl+Shift+PrintScreen' } }])
  await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Reset Bold"]')!.click())
  expect(update.mock.lastCall).toEqual([{ global: { shortcuts: {}, captureShortcut: 'Ctrl+Shift+PrintScreen' } }])
  await record('closeSettings', 'Escape')
  expect(close).not.toHaveBeenCalled()
  await act(async () => [...el.querySelectorAll('button')].find(b => b.textContent === 'Reset all')!.click())
  expect(update.mock.lastCall).toEqual([{ global: { shortcuts: {}, captureShortcut: 'Ctrl+Shift+PrintScreen' } }])
  el.remove()
})
