// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlossApi } from '@shared/ipc'
import type { PluginApi, PluginLibraryState } from '@shared/plugins'
import { PluginsScreen } from './PluginsScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let state: PluginLibraryState
let api: PluginApi
let guard: ((leave: () => void) => void) | null
let onClose: ReturnType<typeof vi.fn<() => void>>
const file = { path: 'skills/review-instructions/SKILL.md', content: '---\nname: review-instructions\ndescription: Review changes\n---\n\n# Review\n\nRead the diff.', revision: 'before' }

beforeEach(async () => {
  guard = null
  onClose = vi.fn()
  state = { directory: '/data/plugins/library', errors: [], connections: [{ name: 'Docs', transport: 'stdio', usedBy: ['Code review'] }], plugins: [{
    schemaVersion: 1, id: 'review', name: 'Code review', description: 'Review changes', connections: ['Docs'], enabledAgents: ['claude'], directory: '/data/plugins/library/review', problems: [],
    skills: [{ id: 'review-instructions', name: 'instructions', description: 'Review changes', path: file.path, files: ['SKILL.md'] }],
    agents: [{ id: 'claude', name: 'Claude Code', enabled: true, status: 'ready', support: 'tested', delivery: 'Local plugin', message: 'Available' }, { id: 'custom:local', name: 'Local agent', enabled: false, status: 'setup', support: 'unknown', delivery: 'Configured folder', message: 'Configure a directory.' }]
  }] }
  api = {
    list: vi.fn(async () => structuredClone(state)),
    create: vi.fn(async (name, description) => { state.plugins.push({ ...structuredClone(state.plugins[0]), id: 'new-plugin', name, description, connections: [], enabledAgents: [] }); return 'new-plugin' }),
    update: vi.fn(async (id, change) => { Object.assign(state.plugins.find(p => p.id === id)!, change) }),
    remove: vi.fn(async id => { state.plugins = state.plugins.filter(p => p.id !== id) }),
    addSkill: vi.fn(async () => 'extra'), removeSkill: vi.fn(async () => {}),
    readFile: vi.fn(async () => ({ ...file })), writeFile: vi.fn(async () => {}), createFile: vi.fn(async () => {}),
    enable: vi.fn(async (_id, _agent, enabled) => { state.plugins[0].agents[0].enabled = enabled; state.plugins[0].agents[0].status = enabled ? 'ready' : 'off' }),
    setSkillDirectory: vi.fn(async () => {}), refresh: vi.fn(async () => {}), openFolder: vi.fn(async () => {})
  }
  Object.defineProperty(window, 'gloss', { configurable: true, value: { plugins: api, onEvent: () => () => {} } as unknown as GlossApi })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<PluginsScreen onManageConnections={() => {}} onClose={onClose} onNavigationGuard={value => { guard = value }} />))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })

async function click(text: string, within: ParentNode = document): Promise<void> {
  const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)
  expect(button, `Button ${text}`).toBeTruthy()
  await act(async () => button!.click())
}
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function edit(): Promise<HTMLTextAreaElement> {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  await click('Edit')
  return container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')!
}

it('keeps availability out of the library list and changes it only from Agents', async () => {
  expect(container.querySelector('.plugin-list')!.textContent).not.toMatch(/Available|Claude|Local agent/)
  await click('Agents')
  const control = container.querySelector<HTMLButtonElement>('[aria-label="Claude Code: disable Code review"]')!
  await act(async () => control.click())
  expect(api.enable).toHaveBeenCalledWith('review', 'claude', false)
  expect(container.querySelector('[aria-label="Claude Code: enable Code review"]')?.textContent).toBe('Off')
})

it('retains the draft after a rejected concurrent save and exposes the conflict', async () => {
  vi.mocked(api.writeFile).mockRejectedValueOnce(new Error('This file changed outside the editor. Reload it before saving.'))
  const editor = await edit(); await input(editor, 'My unsaved instructions')
  await click('Save changes')
  expect(api.writeFile).toHaveBeenCalledWith('review', { ...file, content: 'My unsaved instructions' })
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toBe('My unsaved instructions')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('changed outside')
})

it('asks before leaving an unsaved file and keeps it when the dialog is cancelled', async () => {
  await input(await edit(), 'Unsaved')
  const leave = vi.fn()
  act(() => guard!(leave))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard unsaved changes')
  await click('Cancel', document.querySelector('[role="dialog"]')!)
  expect(leave).not.toHaveBeenCalled()
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toBe('Unsaved')
  act(() => guard!(leave))
  await click('Discard changes')
  expect(leave).toHaveBeenCalledOnce()
})

it('removes a connection reference without deleting or rewriting the global connection', async () => {
  await click('Tools'); await click('Remove from plugin')
  expect(api.update).toHaveBeenCalledWith('review', { connections: [] })
  expect(state.connections).toHaveLength(1)
  expect(container.textContent).toContain('global MCP connection is preserved')
})

it('opens New plugin directly and creates its first editable skill', async () => {
  await click('New plugin')
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toMatch(/Import|Discover|marketplace/)
  const form = document.querySelector<HTMLFormElement>('.plugin-dialog form')!
  await input(form.querySelector('input')!, 'My workflow')
  await input(form.querySelector('textarea')!, 'Help with my workflow')
  await click('Create plugin')
  expect(api.create).toHaveBeenCalledWith('My workflow', 'Help with my workflow')
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toContain('Read the diff')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('keeps custom agent directory setup explicit and requires format confirmation', async () => {
  await click('Agents')
  const control = container.querySelector<HTMLButtonElement>('[aria-label="Local agent: enable Code review"]')!
  await act(async () => control.click())
  const form = document.querySelector<HTMLFormElement>('.plugin-dialog form')!
  await input(form.querySelector('input:not([type="checkbox"])')!, 'C:/agent/skills')
  expect([...form.querySelectorAll('button')].find(b => b.textContent === 'Save directory')!.disabled).toBe(true)
  await act(async () => form.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await click('Save directory')
  expect(api.setSkillDirectory).toHaveBeenCalledWith('custom:local', 'C:/agent/skills')
  expect(api.enable).not.toHaveBeenCalled()
})

it('closes with Done or Esc, asking first when a file has unsaved edits', async () => {
  await click('Done')
  expect(onClose).toHaveBeenCalledOnce()
  await input(await edit(), 'Unsaved')
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(onClose).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard unsaved changes')
  await click('Discard changes')
  expect(onClose).toHaveBeenCalledTimes(2)
})
