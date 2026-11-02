// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GlossApi, GlossEvent } from '@shared/ipc'
import type { PluginApi, PluginLibraryState } from '@shared/plugins'
import { PluginsScreen } from './PluginsScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
let state: PluginLibraryState
let api: PluginApi
let emit: (event: GlossEvent) => void
let onClose: ReturnType<typeof vi.fn<() => void>>
const file = { path: 'skills/review-instructions/SKILL.md', content: '---\nname: review-instructions\ndescription: Review changes\n---\n\n# Review\n\nRead the diff.', revision: 'before' }

beforeEach(async () => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(): void { this.callback([{ contentRect: { width: 1200 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    disconnect(): void {}
  })
  onClose = vi.fn()
  state = { directory: '/data/plugins/library', errors: [], connections: [{ name: 'Docs', transport: 'stdio', usedBy: ['Code review'] }], plugins: [{
    schemaVersion: 1, id: 'review', name: 'Code review', description: 'Review changes', connections: ['Docs'], enabledAgents: ['claude'], directory: '/data/plugins/library/review', problems: [], subagents: [], hooks: [],
    skills: [{ id: 'review-instructions', name: 'instructions', description: 'Review changes', path: file.path, files: ['SKILL.md', 'references/checklist.txt'], invocation: 'automatic' }],
    agents: [{ id: 'claude', name: 'Claude Code', enabled: true, status: 'ready', support: 'tested', message: 'Available' }, { id: 'custom:local', name: 'Local agent', enabled: false, status: 'setup', support: 'unknown', message: 'Configure a directory.' }]
  }] }
  api = {
    list: vi.fn(async () => structuredClone(state)),
    readFile: vi.fn(async (_id, path) => path === file.path ? { ...file } : { path, content: 'Supporting checklist', revision: 'reference' }),
    enable: vi.fn(async (_id, _agent, enabled) => { state.plugins[0].agents[0].enabled = enabled; state.plugins[0].agents[0].status = enabled ? 'ready' : 'off' }),
    setSkillDirectory: vi.fn(async () => {}), refresh: vi.fn(async () => {}), openFolder: vi.fn(async () => {}), openInEditor: vi.fn(async () => {})
  }
  Object.defineProperty(window, 'gloss', { configurable: true, value: { plugins: api, onEvent: (listener: (event: GlossEvent) => void) => { emit = listener; return () => {} } } as unknown as GlossApi })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<PluginsScreen onManageConnections={() => {}} onClose={onClose} />))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function click(text: string, within: ParentNode = document): Promise<void> {
  const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)
  expect(button, `Button ${text}`).toBeTruthy()
  await act(async () => button!.click())
}
async function input(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function openSkill(): Promise<void> {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
}

it('is a view of the library: no controls that create, edit or remove plugin files', async () => {
  const labels = (): string[] => [...document.querySelectorAll('button')].flatMap(b => [b.textContent?.trim() ?? '', b.getAttribute('aria-label') ?? ''])
  const editing = /New plugin|Edit plugin|Remove plugin|Add skill|Remove skill|New text file|Edit file|Delete file|Add connection|Remove from plugin/
  expect(labels().filter(l => editing.test(l))).toEqual([])
  await openSkill()
  expect(labels().filter(l => editing.test(l))).toEqual([])
  expect(container.querySelector('textarea')).toBeNull()
  expect(container.querySelector('[aria-label="Skill invocation"]')).toBeNull()
  await click('MCP')
  expect(labels().filter(l => editing.test(l))).toEqual([])
  expect(container.querySelector('.plugin-library-header')!.textContent).toContain('gloss:new-plugin')
})

it('always shows the Subagents and Hooks tabs and overview groups, even when empty', async () => {
  expect([...container.querySelectorAll('.plugin-tabs button')].map(b => b.textContent)).toEqual(['Overview', 'Skills', 'Subagents', 'Hooks', 'MCP', 'Agents'])
  expect([...container.querySelectorAll('.plugin-component-group h4')].map(h => h.textContent)).toEqual(['Skills', 'Subagents', 'Hooks', 'MCP servers'])
  await click('Subagents')
  expect(container.querySelector('.plugin-detail-content')!.textContent).toBe('Subagents in this plugin')
  await click('Hooks')
  expect(container.querySelector('.plugin-detail-content')!.textContent).toBe('Hooks in this plugin')
  expect(api.readFile).not.toHaveBeenCalled()
})

it('leaves out what a plugin has none of in the library list', async () => {
  expect(container.querySelector('.plugin-list-item small')!.textContent).toBe('1 skill · Docs')
  Object.assign(state.plugins[0], { skills: [], connections: [], hooks: [{ event: 'stop', command: 'node done.js', timeout: 60 }] })
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect(container.querySelector('.plugin-list-item small')!.textContent).toBe('1 hook')
  state.plugins[0].hooks = []
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect(container.querySelector('.plugin-list-item small')!.textContent).toBe('Empty')
})

it('keeps availability out of the library list and changes it only from Agents', async () => {
  expect(container.querySelector('.plugin-list')!.textContent).not.toMatch(/Available|Claude|Local agent/)
  await click('Agents')
  const control = container.querySelector<HTMLButtonElement>('[aria-label="Claude Code: disable Code review"]')!
  await act(async () => control.click())
  expect(api.enable).toHaveBeenCalledWith('review', 'claude', false)
  expect(container.querySelector('[aria-label="Claude Code: enable Code review"]')?.textContent).toBe('Off')
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

it('keeps failed dialog operations inside the dialog without a page banner', async () => {
  vi.mocked(api.setSkillDirectory).mockRejectedValueOnce(new Error('Enter an absolute skill-directory path.'))
  await click('Agents')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Local agent: enable Code review"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  await input(dialog.querySelector('input:not([type="checkbox"])')!, 'relative')
  await act(async () => dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
  await click('Save directory', dialog)
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Enter an absolute skill-directory path.')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  await click('Cancel', dialog)
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it('closes with Esc, unless a dialog is open', async () => {
  await click('Agents')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Local agent: enable Code review"]')!.click())
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(onClose).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(onClose).toHaveBeenCalledOnce()
})

it('opens the selected file in the external editor and reports launch failures', async () => {
  await openSkill()
  const external = container.querySelector<HTMLButtonElement>('[aria-label="Open in external editor"]')!
  expect(external.textContent).toBe('')
  await act(async () => external.click())
  expect(api.openInEditor).toHaveBeenCalledWith('review', file.path)
  vi.mocked(api.openInEditor).mockRejectedValueOnce(new Error('Choose an external editor in Settings first.'))
  await act(async () => external.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Choose an external editor')
})

it('remembers the resized detail width and resets it on double-click', async () => {
  const panel = container.querySelector<HTMLElement>('.plugin-detail')!
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 390 } as DOMRect)
  const handle = container.querySelector<HTMLElement>('[aria-label="Resize plugin details"]')!
  await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  expect(localStorage.getItem('gloss.pluginDetailWidth')).toBe('406')
  expect(panel.style.getPropertyValue('--plugin-detail-width')).toBe('406px')
  vi.mocked(panel.getBoundingClientRect).mockReturnValue({ width: 960 } as DOMRect)
  await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })))
  expect(localStorage.getItem('gloss.pluginDetailWidth')).toBe('960')
  await act(async () => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
  expect(localStorage.getItem('gloss.pluginDetailWidth')).toBeNull()
  expect(panel.style.getPropertyValue('--plugin-detail-width')).toBe('')
})

it('switches between instructions and supporting files with a single picker', async () => {
  await openSkill()
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  expect(picker.selectedOptions[0].textContent).toBe('SKILL.md')
  expect([...picker.options].map(o => o.textContent)).toEqual(['SKILL.md', 'references/checklist.txt'])
  const path = 'skills/review-instructions/references/checklist.txt'
  await act(async () => { picker.value = path; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.readFile).toHaveBeenLastCalledWith('review', path)
  expect(container.querySelector('.plugin-file-content')?.textContent).toBe('Supporting checklist')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in external editor"]')!.click())
  expect(api.openInEditor).toHaveBeenCalledWith('review', path)
  await act(async () => { picker.value = file.path; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector('.plugin-detail-content')?.textContent).toContain('Read the diff.')
})

it('says when a skill is direct only', async () => {
  state.plugins[0].skills[0].invocation = 'direct'
  await act(async () => emit({ type: 'pluginsChanged' }))
  await openSkill()
  expect([...container.querySelectorAll('.plugin-part-settings dd')].map(d => d.textContent)[0]).toBe('Direct onlyUsed only when you invoke it.')
})

it.each(['library folder', 'plugin folder', 'external editor'])('scopes %s launch progress without reloading the library', async action => {
  await openSkill()
  const initialLists = vi.mocked(api.list).mock.calls.length
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  const external = container.querySelector<HTMLButtonElement>('[aria-label="Open in external editor"]')!
  const pluginFolder = container.querySelector<HTMLButtonElement>('[aria-label="Open plugin folder"]')!
  const libraryFolder = container.querySelector<HTMLButtonElement>('.plugin-library-folder')!
  const target = action === 'external editor' ? external : action === 'library folder' ? libraryFolder : pluginFolder
  const method = action === 'external editor' ? api.openInEditor : api.openFolder
  vi.mocked(method).mockReturnValueOnce(promise)
  await act(async () => { target.click(); target.click() })
  expect(method).toHaveBeenCalledTimes(1)
  expect(target.disabled).toBe(true)
  for (const button of [external, pluginFolder, libraryFolder].filter(b => b !== target)) {
    expect(button.disabled).toBe(false)
    expect(button.isConnected).toBe(true)
  }
  await act(async () => finish())
  expect(target.disabled).toBe(false)
  expect(api.list).toHaveBeenCalledTimes(initialLists)
})

it('keeps other agent and library controls enabled while toggling one agent', async () => {
  await click('Agents')
  let finish!: () => void
  vi.mocked(api.enable).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const target = container.querySelector<HTMLButtonElement>('[aria-label="Claude Code: disable Code review"]')!
  const other = container.querySelector<HTMLButtonElement>('[aria-label="Local agent: enable Code review"]')!
  await act(async () => { target.click(); target.click() })
  expect(api.enable).toHaveBeenCalledTimes(1)
  expect(target.disabled).toBe(true)
  expect(other.disabled).toBe(false)
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open plugin folder"]')!.disabled).toBe(false)
  await act(async () => finish())
  expect(target.disabled).toBe(false)
})

it('keeps an existing preview mounted when reloading the same file', async () => {
  await openSkill()
  const external = container.querySelector<HTMLButtonElement>('[aria-label="Open in external editor"]')!
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  let finish!: () => void
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve({ ...file }) }))
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  expect(external.isConnected).toBe(true)
  expect(container.textContent).not.toContain('Loading file')
  await act(async () => finish())
  expect(external.isConnected).toBe(true)
})

it('updates externally changed previews in place', async () => {
  await openSkill()
  const external = container.querySelector<HTMLButtonElement>('[aria-label="Open in external editor"]')!
  vi.mocked(api.readFile).mockResolvedValueOnce({ ...file, content: '# Updated externally', revision: 'external' })
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect(api.readFile).toHaveBeenLastCalledWith('review', file.path)
  expect(container.querySelector('.plugin-detail-content')?.textContent).toContain('Updated externally')
  expect(container.querySelector('.plugin-detail-content')?.textContent).not.toContain('Read the diff.')
  expect(external.isConnected).toBe(true)
  expect(external.disabled).toBe(false)
})

it('refreshes the selected supporting file after external changes', async () => {
  await openSkill()
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  const path = 'skills/review-instructions/references/checklist.txt'
  await act(async () => { picker.value = path; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  vi.mocked(api.readFile).mockResolvedValueOnce({ path, content: 'New supporting text', revision: 'external-reference' })
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect(api.readFile).toHaveBeenLastCalledWith('review', path)
  expect(container.querySelector('.plugin-file-content')?.textContent).toBe('New supporting text')
  expect(picker.value).toBe(path)
})

it('ignores external preview responses after navigation', async () => {
  await openSkill()
  let finish!: () => void
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve({ ...file, content: 'External text', revision: 'external' }) }))
  await act(async () => emit({ type: 'pluginsChanged' }))
  await click('Agents')
  await act(async () => finish())
  expect(container.querySelector('[aria-label="Plugin sections"] [aria-current="page"]')?.textContent).toBe('Agents')
  expect(container.querySelector('.plugin-detail-content')?.textContent).not.toContain('External text')
})

it('keeps the newest external refresh when responses arrive out of order', async () => {
  await openSkill()
  let finishOld!: () => void
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise(resolve => { finishOld = () => resolve({ ...file, content: 'Old external text', revision: 'old' }) }))
  await act(async () => emit({ type: 'pluginsChanged' }))
  vi.mocked(api.readFile).mockResolvedValueOnce({ ...file, content: 'Newest external text', revision: 'newest' })
  await act(async () => emit({ type: 'pluginsChanged' }))
  await act(async () => finishOld())
  expect(container.querySelector('.plugin-detail-content')?.textContent).toContain('Newest external text')
  expect(container.querySelector('.plugin-detail-content')?.textContent).not.toContain('Old external text')
})

it('shows plugin and library health errors', async () => {
  state.plugins[0].problems = ['This plugin is incomplete because plugin.json is missing.']
  state.errors = ['Library health issue']
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect([...container.querySelectorAll('[role="alert"]')].map(a => a.textContent)).toEqual(['Library health issue', 'This plugin is incomplete because plugin.json is missing.'])
})

it('shows the built-in plugin read-only and always on, without selecting it by default', async () => {
  state.plugins.unshift({
    schemaVersion: 1, id: 'gloss:builtin', builtin: true, name: 'Gloss plugins', description: 'Built into Gloss.', connections: [], enabledAgents: ['claude', 'custom:local'], directory: '/data/plugins/runtime/builtin', problems: [], subagents: [], hooks: [],
    skills: [{ id: 'new-plugin', name: 'new-plugin', description: 'Create or import a plugin.', path: 'skills/new-plugin/SKILL.md', files: ['SKILL.md'], invocation: 'automatic' }],
    agents: [{ id: 'claude', name: 'Claude Code', enabled: true, status: 'ready', support: 'tested', message: '' }, { id: 'custom:local', name: 'Local agent', enabled: true, status: 'setup', support: 'unknown', message: 'Gets it once this custom agent’s skill directory is set.' }]
  })
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect(container.querySelector('.plugin-detail h3')!.textContent).toBe('Code review')
  const item = [...container.querySelectorAll<HTMLButtonElement>('.plugin-list-item')].find(b => b.textContent?.includes('Gloss plugins'))!
  expect(item.textContent).toContain('Built in · always on')
  await act(async () => item.click())
  const detail = container.querySelector('.plugin-detail')!
  expect(detail.textContent).toContain('read-only')
  expect(detail.querySelector('[aria-label="Open plugin folder"]')).toBeNull()
  expect([...detail.querySelectorAll('.plugin-tabs button')].map(b => b.textContent)).toEqual(['Overview', 'Skills', 'Subagents', 'Hooks', 'MCP', 'Agents'])
  expect([...detail.querySelectorAll('.plugin-component-group h4')].map(h => h.textContent)).toEqual(['Skills', 'Subagents', 'Hooks', 'MCP servers'])
  await click('Agents', detail)
  expect(detail.querySelector('.plugin-agent button.plugin-availability')).toBeNull()
  expect(detail.textContent).toContain('Always on')
  expect(detail.textContent).toContain('Gets it once')
  await click('Skills', detail)
  await act(async () => detail.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  expect(api.readFile).toHaveBeenLastCalledWith('gloss:builtin', 'skills/new-plugin/SKILL.md')
  expect(detail.querySelector('[aria-label="Open in external editor"]')).toBeNull()
  expect(detail.textContent).not.toContain('Direct only')
})

it('shows subagents and hooks, and lists a plugin’s hook commands before turning it on for an agent', async () => {
  vi.mocked(api.readFile).mockImplementation(async (_id, path) => path === 'agents/reviewer.md' ? { path, content: '---\nname: reviewer\ndescription: Reviews\n---\n\nReview the diff.', revision: 'agent' } : { ...file })
  Object.assign(state.plugins[0], {
    subagents: [{ id: 'reviewer', description: 'Reviews changes.', tools: 'read-only', models: { claude: 'haiku' }, path: 'agents/reviewer.md' }],
    hooks: [
      { event: 'beforeTool', matcher: 'shell', command: 'node check.js', timeout: 60 },
      { event: 'PreCompact', command: 'node save.js', timeout: 5, agents: ['claude'] },
      { event: 'stop', command: 'node done.js', timeout: 60, agents: ['codex'] }
    ]
  })
  state.plugins[0].agents[0] = { ...state.plugins[0].agents[0], enabled: false, status: 'off' }
  await act(async () => emit({ type: 'pluginsChanged' } as GlossEvent))
  expect(container.querySelector('.plugin-list')!.textContent).toContain('1 subagent · 3 hooks')

  await click('Subagents')
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  expect(api.readFile).toHaveBeenLastCalledWith('review', 'agents/reviewer.md')
  expect([...container.querySelectorAll('.plugin-part-settings dt, .plugin-part-settings dd')].map(d => d.textContent)).toEqual(['Tools', 'Read-onlyIt can’t edit files or run shell commands.', 'Model', 'haiku in Claude CodeThe session’s model in other agents.'])
  expect(container.querySelector('.plugin-detail-content')!.textContent).toContain('Review the diff.')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open in external editor"]')!.click())
  expect(api.openInEditor).toHaveBeenLastCalledWith('review', 'agents/reviewer.md')

  await click('Hooks')
  const hooks = [...container.querySelectorAll('.plugin-hook')].map(h => h.textContent)
  expect(hooks[0]).toBe('Before a tool runsShell commandsnode check.jsEvery agent · stops after 60 s')
  expect(hooks[1]).toBe('PreCompactnode save.jsOnly Claude Code · stops after 5 s')
  expect(container.querySelector('[aria-label="Open in external editor"]')).toBeNull()

  await click('Agents')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Claude Code: enable Code review"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('Turn on hooks?')
  // Only the hooks Claude Code would run.
  expect([...dialog.querySelectorAll('code')].map(c => c.textContent)).toEqual(['node check.js', 'node save.js'])
  expect(api.enable).not.toHaveBeenCalled()
  await click('Turn on', dialog)
  expect(api.enable).toHaveBeenCalledWith('review', 'claude', true)
})
