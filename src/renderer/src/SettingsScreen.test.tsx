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
  global: { defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', listItemReplies: false, turnEndSound: true, externalEditor: '', mcpServers: [] },
  projects: { 'C:/projects/website': { obsidianVault: 'Website notes' } }
}

it('lists every open project and writes overrides to the selected project without an active session', async () => {
  const update = vi.fn(async () => {})
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
