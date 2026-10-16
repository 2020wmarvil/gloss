// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { McpSettings } from './McpSettings'
import { SettingsScreen } from './SettingsScreen'
import type { McpImportPreview, McpServer } from '@shared/mcp'
import type { SettingsState } from '@shared/ipc'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => act(() => root?.unmount()))
const server: McpServer = { name: 'tools', command: '/tools/server', args: ['', 'line\nbreak'], env: [{ name: 'MODE', value: 'local' }] }
async function mount(servers: McpServer[] = [], save = vi.fn<(servers: McpServer[]) => Promise<void>>(async () => {}), preview: McpImportPreview = { entries: [], problems: [] }) {
  const discover = vi.fn(async () => preview)
  window.gloss = { settings: { previewMcpImport: discover } } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<McpSettings servers={servers} onSave={save} />))
  return { el, save, discover }
}
const button = (el: Element, text: string): HTMLButtonElement => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!
const click = async (el: HTMLElement): Promise<void> => act(async () => el.click())
const edit = async (input: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> => act(async () => {
  const proto = input.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

it('places the MCP list under Global without needing an open project', async () => {
  const { el } = await mount()
  const state: SettingsState = { path: '/settings.json', error: null, projects: {}, global: { defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', listItemReplies: false, externalEditor: '', mcpServers: [] } }
  const update = vi.fn(async () => {})
  await act(async () => root!.render(<SettingsScreen state={state} projectPath={null} onUpdate={update} onClose={() => {}} onOpenFile={async () => null} />))
  const global = [...el.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === 'Global')!
  const project = [...el.querySelectorAll('section')].find((s) => s.querySelector('h2')?.textContent === 'Project')!
  expect(global.querySelector('.mcp-settings')).not.toBeNull()
  expect(project.textContent).toContain("Open a session to see its project")
  expect(project.querySelector('.mcp-settings')).toBeNull()
  await click(button(global, 'Add server'))
  const inputs = global.querySelectorAll<HTMLInputElement>('form input')
  await edit(inputs[0], 'new')
  await edit(inputs[1], '/new/server')
  await act(async () => global.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(update).toHaveBeenCalledWith({ global: { mcpServers: [{ name: 'new', command: '/new/server', args: [], env: [] }] } })
})

it('preserves a server editor after save failures and preserves exact arguments', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('File is locked')).mockResolvedValue(undefined)
  const { el } = await mount([server], save)
  await click(button(el, 'Edit'))
  const submit = async (): Promise<void> => act(async () => { el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  await submit()
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('File is locked')
  expect(el.querySelector('form')).not.toBeNull()
  await submit()
  expect(save).toHaveBeenLastCalledWith([server])
  expect(el.querySelector('form')).toBeNull()
  expect(el.querySelector('[role="alert"]')).toBeNull()
})

it('prevents normalized name collisions when adding and supports removing servers', async () => {
  const { el, save } = await mount([{ ...server, name: 'team_tools' }])
  await click(button(el, 'Add server'))
  const inputs = el.querySelectorAll<HTMLInputElement>('form input')
  await edit(inputs[0], 'team tools')
  await edit(inputs[1], '/new/server')
  await act(async () => el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(save).not.toHaveBeenCalled()
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('duplicate name')
  await click(button(el, 'Cancel'))
  await click(button(el, 'Remove'))
  expect(save).toHaveBeenCalledWith([])
})

it('previews imports without saving, skips duplicates and unsupported entries, and permits renaming', async () => {
  const preview: McpImportPreview = { entries: [
    { id: '0', name: 'team tools', source: '/claude.json', server: { ...server, name: 'team tools' } },
    { id: '1', name: 'UnityMCP', source: '/BoxPuzzler2024', server: { name: 'UnityMCP', type: 'http', url: 'http://localhost:8080/mcp', headers: [{ name: 'Authorization', value: 'secret-token' }] } },
    { id: '2', name: 'restricted', source: '/codex/config.toml', problem: 'Cannot preserve these settings: enabled_tools' }
  ], problems: [] }
  const { el, save, discover } = await mount([{ ...server, name: 'team_tools' }], undefined, preview)
  await click(button(el, 'Import from Claude'))
  expect(discover).toHaveBeenCalledWith('claude')
  expect(save).not.toHaveBeenCalled()
  expect(el.textContent).toContain('/BoxPuzzler2024')
  expect(el.textContent).not.toContain('secret-token')
  const checks = el.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
  expect(checks[0].checked).toBe(false)
  expect(checks[1].checked).toBe(true)
  expect(checks[2].disabled).toBe(true)
  await click(checks[0])
  expect(button(el, 'Import selected (2)').disabled).toBe(true)
  await edit(el.querySelector<HTMLInputElement>('input[aria-label="Import team tools as (0)"]')!, 'renamed_tools')
  expect(button(el, 'Import selected (2)').disabled).toBe(false)
  await click(button(el, 'Import selected (2)'))
  expect(save).toHaveBeenCalledWith([{ ...server, name: 'team_tools' }, { ...server, name: 'renamed_tools' }, preview.entries[1].server])
})

it('cancels import without saving and reports discovery failures', async () => {
  const { el, save, discover } = await mount()
  await click(button(el, 'Import from Codex'))
  expect(el.textContent).toContain('No MCP servers found')
  await click(button(el, 'Cancel import'))
  expect(save).not.toHaveBeenCalled()
  discover.mockRejectedValueOnce(new Error('Cannot read configuration'))
  await click(button(el, 'Import from Codex'))
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('Cannot read configuration')
})


it('edits the vault for the open project with a normalized path lookup', async () => {
  const { el } = await mount()
  const state: SettingsState = { path: '/settings.json', error: null,
    projects: { 'C:/Work/Project/': { obsidianVault: 'Old notes' } },
    global: { defaultAgent: 'claude', theme: 'system', sessionOrder: 'created', listItemReplies: false, externalEditor: '', mcpServers: [] } }
  const update = vi.fn(async () => {})
  await act(async () => root!.render(<SettingsScreen state={state} projectPath="c:/work/project" onUpdate={update} onClose={() => {}} onOpenFile={async () => null} />))
  const input = el.querySelector<HTMLInputElement>('#setting-obsidianVault')!
  expect(input.value).toBe('Old notes')
  await edit(input, 'Project notes')
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(update).toHaveBeenCalledWith({ project: { path: 'c:/work/project', values: { obsidianVault: 'Project notes' } } })
})
