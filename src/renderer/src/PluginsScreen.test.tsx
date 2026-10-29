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
let guard: ((leave: () => void) => void) | null
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
  guard = null
  onClose = vi.fn()
  state = { directory: '/data/plugins/library', errors: [], connections: [{ name: 'Docs', transport: 'stdio', usedBy: ['Code review'] }], plugins: [{
    schemaVersion: 1, id: 'review', name: 'Code review', description: 'Review changes', connections: ['Docs'], enabledAgents: ['claude'], directory: '/data/plugins/library/review', problems: [],
    skills: [{ id: 'review-instructions', name: 'instructions', description: 'Review changes', path: file.path, files: ['SKILL.md', 'references/checklist.txt'], invocation: 'automatic', invocationRevision: 'policy-before' }],
    agents: [{ id: 'claude', name: 'Claude Code', enabled: true, status: 'ready', support: 'tested', message: 'Available' }, { id: 'custom:local', name: 'Local agent', enabled: false, status: 'setup', support: 'unknown', message: 'Configure a directory.' }]
  }] }
  api = {
    list: vi.fn(async () => structuredClone(state)),
    create: vi.fn(async (name, description) => { state.plugins.push({ ...structuredClone(state.plugins[0]), id: 'new-plugin', name, description, connections: [], enabledAgents: [] }); return 'new-plugin' }),
    update: vi.fn(async (id, change) => { Object.assign(state.plugins.find(p => p.id === id)!, change) }),
    remove: vi.fn(async id => { state.plugins = state.plugins.filter(p => p.id !== id) }),
    setSkillInvocation: vi.fn(async (_id, skillId, invocation) => { state.plugins[0].skills.find(s => s.id === skillId)!.invocation = invocation }),
    addSkill: vi.fn(async () => 'extra'), removeSkill: vi.fn(async () => {}),
    readFile: vi.fn(async (_id, path) => path === file.path ? { ...file } : { path, content: 'Supporting checklist', revision: 'reference' }), writeFile: vi.fn(async () => {}), removeFile: vi.fn(async () => {}), createFile: vi.fn(async () => {}),
    enable: vi.fn(async (_id, _agent, enabled) => { state.plugins[0].agents[0].enabled = enabled; state.plugins[0].agents[0].status = enabled ? 'ready' : 'off' }),
    setSkillDirectory: vi.fn(async () => {}), refresh: vi.fn(async () => {}), openFolder: vi.fn(async () => {}), openInEditor: vi.fn(async () => {})
  }
  Object.defineProperty(window, 'gloss', { configurable: true, value: { plugins: api, onEvent: (listener: (event: GlossEvent) => void) => { emit = listener; return () => {} } } as unknown as GlossApi })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root.render(<PluginsScreen onManageConnections={() => {}} onClose={onClose} onNavigationGuard={value => { guard = value }} />))
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

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
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click())
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
  await click('Save')
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
  expect(container.querySelector('[role="status"]')).toBeNull()
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

it('closes with Esc, asking first when a file has unsaved edits', async () => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(onClose).toHaveBeenCalledOnce()
  await input(await edit(), 'Unsaved')
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(onClose).toHaveBeenCalledOnce()
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard unsaved changes')
  await click('Discard changes')
  expect(onClose).toHaveBeenCalledTimes(2)
})


it('opens the selected file in the external editor and reports launch failures', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  const editButton = container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!
  expect(editButton.textContent).toBe('')
  const external = editButton.nextElementSibling as HTMLButtonElement
  expect(external.getAttribute('aria-label')).toBe('Open in external editor')
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


it('removes a skill while its plugin is enabled', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove skill"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).not.toContain('Turn the plugin off')
  await click('Remove skill', dialog)
  expect(api.removeSkill).toHaveBeenCalledWith('review', 'review-instructions')
  expect(api.enable).not.toHaveBeenCalled()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('keeps failed dialog operations inside the dialog without a page banner', async () => {
  vi.mocked(api.removeSkill).mockRejectedValueOnce(new Error('Wait for active turns to finish.'))
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove skill"]')!.click())
  const dialog = document.querySelector('[role="dialog"]')!
  await click('Remove skill', dialog)
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Wait for active turns to finish.')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  await click('Cancel', dialog)
  expect(document.querySelector('[role="alert"]')).toBeNull()
})


it('switches between instructions and supporting files with a single picker', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  expect(picker.selectedOptions[0].textContent).toBe('SKILL.md')
  expect([...picker.options].map(o => o.textContent)).toEqual(['SKILL.md', 'references/checklist.txt'])
  const path = 'skills/review-instructions/references/checklist.txt'
  await act(async () => { picker.value = path; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(api.readFile).toHaveBeenLastCalledWith('review', path)
  expect(container.querySelector('.plugin-file-content')?.textContent).toBe('Supporting checklist')
  await act(async () => { picker.value = file.path; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(container.querySelector('.plugin-detail-content')?.textContent).toContain('Read the diff.')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New text file"]')!.click())
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('New text file')
})

it('protects unsaved edits when selecting a different skill file', async () => {
  await input(await edit(), 'Unsaved instructions')
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  await act(async () => { picker.value = 'skills/review-instructions/references/checklist.txt'; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Discard unsaved changes')
  expect(api.readFile).toHaveBeenCalledTimes(1)
  await click('Cancel', document.querySelector('[role="dialog"]')!)
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toBe('Unsaved instructions')
  expect(picker.value).toBe(file.path)
})


it('opens newly created files in preview mode', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New text file"]')!.click())
  const form = document.querySelector<HTMLFormElement>('.plugin-dialog form')!
  await input(form.querySelector('input')!, 'notes.txt')
  await input(form.querySelector('textarea')!, 'Notes')
  await click('Create file', form)
  expect(api.createFile).toHaveBeenCalledWith('review', 'review-instructions', 'notes.txt', 'Notes')
  expect(container.querySelector('#plugin-file-editor')).toBeNull()
  expect(container.querySelector('.plugin-file-content')).toBeTruthy()
})

it('deletes supporting files after confirmation and returns to instructions', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  expect(container.querySelector('[aria-label="Delete file"]')).toBeNull()
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  const path = 'skills/review-instructions/references/checklist.txt'
  await act(async () => { picker.value = path; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete file"]')!.click())
  expect(api.removeFile).not.toHaveBeenCalled()
  await click('Delete file', document.querySelector('[role="dialog"]')!)
  expect(api.removeFile).toHaveBeenCalledWith('review', { path, content: 'Supporting checklist', revision: 'reference' })
  expect(picker.value).toBe(file.path)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})


it('opens a newly added skill in preview mode', async () => {
  vi.mocked(api.addSkill).mockImplementationOnce(async (_id, name, description) => {
    state.plugins[0].skills.push({ id: 'extra', name, description, path: 'skills/extra/SKILL.md', files: ['SKILL.md'], invocation: 'automatic', invocationRevision: 'extra-policy' })
    return 'extra'
  })
  await click('Skills')
  await click('Add skill')
  const form = document.querySelector<HTMLFormElement>('.plugin-dialog form')!
  await input(form.querySelector('input')!, 'Extra skill')
  await input(form.querySelector('textarea')!, 'Help with an extra task')
  await click('Add skill', form)
  expect(api.addSkill).toHaveBeenCalledWith('review', 'Extra skill', 'Help with an extra task', 'automatic')
  expect(api.readFile).toHaveBeenLastCalledWith('review', 'skills/extra/SKILL.md')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('#plugin-file-editor')).toBeNull()
  expect(container.querySelector('[aria-label="Edit file"]')).toBeTruthy()
  expect(container.querySelector('.plugin-detail-content')?.textContent).toContain('Supporting checklist')
})


it('changes invocation for the skill and refreshes its open preview', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  const picker = container.querySelector<HTMLFieldSetElement>('[aria-label="Skill invocation"]')!
  expect(picker.querySelector<HTMLInputElement>('input:checked')?.value).toBe('automatic')
  await act(async () => picker.querySelector<HTMLInputElement>('input[value="direct"]')!.click())
  expect(api.setSkillInvocation).toHaveBeenCalledWith('review', 'review-instructions', 'direct', 'policy-before')
  expect(picker.querySelector<HTMLInputElement>('input:checked')?.value).toBe('direct')
  expect(picker.querySelector<HTMLInputElement>('input[value="direct"]')?.parentElement?.title).toContain('custom agents are unverified')
  expect(container.querySelector('#plugin-file-editor')).toBeNull()
})

it('asks before changing invocation with unsaved instructions', async () => {
  await input(await edit(), 'Unsaved')
  const picker = container.querySelector<HTMLFieldSetElement>('[aria-label="Skill invocation"]')!
  await act(async () => picker.querySelector<HTMLInputElement>('input[value="direct"]')!.click())
  expect(api.setSkillInvocation).not.toHaveBeenCalled()
  await click('Cancel', document.querySelector('[role="dialog"]')!)
  expect(picker.querySelector<HTMLInputElement>('input:checked')?.value).toBe('automatic')
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toBe('Unsaved')
})


it('offers invocation during skill creation in the compact styled dialog', async () => {
  vi.mocked(api.addSkill).mockImplementationOnce(async (_id, name, description, invocation) => {
    state.plugins[0].skills.push({ id: 'extra', name, description, invocation: invocation ?? 'automatic', invocationRevision: 'extra-policy', path: 'skills/extra/SKILL.md', files: ['SKILL.md'] })
    return 'extra'
  })
  await click('Skills')
  await click('Add skill')
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  expect(dialog.classList.contains('plugin-create-dialog')).toBe(true)
  expect(dialog.querySelector('.plugin-create-mark')).toBeTruthy()
  const form = dialog.querySelector('form')!
  expect(form.querySelector('input')!.placeholder).toBe('e.g. Summarize')
  await input(form.querySelector('input')!, 'Direct skill')
  await input(form.querySelector('textarea')!, 'Only when requested')
  expect(form.querySelector<HTMLInputElement>('input[name="invocation"][value="automatic"]')!.checked).toBe(true)
  await act(async () => form.querySelector<HTMLInputElement>('input[name="invocation"][value="direct"]')!.click())
  expect(form.querySelector<HTMLInputElement>('input[name="invocation"][value="direct"]')!.checked).toBe(true)
  await click('Add skill', form)
  expect(api.addSkill).toHaveBeenCalledWith('review', 'Direct skill', 'Only when requested', 'direct')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector<HTMLInputElement>('[aria-label="Skill invocation"] input:checked')?.value).toBe('direct')
  expect(container.querySelector('#plugin-file-editor')).toBeNull()
})


it('keeps unrelated buttons and the preview stable throughout invocation changes', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  let finishSave!: () => void
  let finishRead!: () => void
  vi.mocked(api.setSkillInvocation).mockImplementationOnce(async (_id, _skillId, invocation) => {
    await new Promise<void>(resolve => { finishSave = resolve })
    state.plugins[0].skills[0].invocation = invocation
  })
  vi.mocked(api.readFile).mockImplementationOnce(() => new Promise(resolve => { finishRead = () => resolve({ ...file }) }))
  const newPlugin = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'New plugin')!
  const editButton = container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!
  const externalButton = container.querySelector<HTMLButtonElement>('[aria-label="Open in external editor"]')!
  const preview = container.querySelector('.plugin-detail-content p')!
  const invocation = container.querySelector<HTMLFieldSetElement>('[aria-label="Skill invocation"]')!
  await act(async () => invocation.querySelector<HTMLInputElement>('input[value="direct"]')!.click())
  for (const button of [newPlugin, editButton, externalButton]) expect(button.disabled).toBe(false)
  expect(invocation.disabled).toBe(true)
  expect(preview.isConnected).toBe(true)
  await act(async () => finishSave())
  expect(editButton.isConnected).toBe(true)
  expect(externalButton.isConnected).toBe(true)
  expect(preview.isConnected).toBe(true)
  expect(container.textContent).not.toContain('Loading file')
  await act(async () => finishRead())
  expect(invocation.disabled).toBe(false)
  for (const button of [newPlugin, editButton, externalButton]) {
    expect(button.disabled).toBe(false)
    expect(button.isConnected).toBe(true)
  }
})

it('preserves navigation while an invocation change is saving', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  let finish!: () => void
  vi.mocked(api.setSkillInvocation).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Skill invocation"] input[value="direct"]')!.click())
  await click('Agents')
  await act(async () => finish())
  expect(container.querySelector('[aria-label="Plugin sections"] [aria-current="page"]')?.textContent).toBe('Agents')
  expect(api.readFile).toHaveBeenCalledTimes(1)
})

it('preserves edits started while invocation is saving', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  let finish!: () => void
  vi.mocked(api.setSkillInvocation).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => container.querySelector<HTMLInputElement>('[aria-label="Skill invocation"] input[value="direct"]')!.click())
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click())
  await input(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')!, 'New draft')
  await act(async () => finish())
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toBe('New draft')
  expect(api.readFile).toHaveBeenCalledTimes(1)
})


it.each(['library folder', 'plugin folder', 'external editor'])('scopes %s launch progress without reloading the library', async action => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  const initialLists = vi.mocked(api.list).mock.calls.length
  let finish!: () => void
  const promise = new Promise<void>(resolve => { finish = resolve })
  const external = container.querySelector<HTMLButtonElement>('[aria-label="Open in external editor"]')!
  const pluginFolder = container.querySelector<HTMLButtonElement>('[aria-label="Open plugin folder"]')!
  const libraryFolder = container.querySelector<HTMLButtonElement>('.plugin-library-folder')!
  const editButton = container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!
  const newFile = container.querySelector<HTMLButtonElement>('[aria-label="New text file"]')!
  const newPlugin = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'New plugin')!
  const target = action === 'external editor' ? external : action === 'library folder' ? libraryFolder : pluginFolder
  const method = action === 'external editor' ? api.openInEditor : api.openFolder
  vi.mocked(method).mockReturnValueOnce(promise)
  await act(async () => { target.click(); target.click() })
  expect(method).toHaveBeenCalledTimes(1)
  expect(target.disabled).toBe(true)
  for (const button of [external, pluginFolder, libraryFolder, editButton, newFile, newPlugin].filter(b => b !== target)) {
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
  const newPlugin = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'New plugin')!
  await act(async () => { target.click(); target.click() })
  expect(api.enable).toHaveBeenCalledTimes(1)
  expect(target.disabled).toBe(true)
  expect(other.disabled).toBe(false)
  expect(newPlugin.disabled).toBe(false)
  await act(async () => finish())
  expect(target.disabled).toBe(false)
})

it('limits connection update progress to the connection controls', async () => {
  await click('Tools')
  let finish!: () => void
  vi.mocked(api.update).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const newPlugin = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'New plugin')!
  await click('Remove from plugin')
  expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Remove from plugin')!.disabled).toBe(true)
  expect([...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Add connection')!.disabled).toBe(true)
  expect(newPlugin.disabled).toBe(false)
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open plugin folder"]')!.disabled).toBe(false)
  await act(async () => finish())
})

it('locks only the file being saved and preserves navigation to other views', async () => {
  const editor = await edit()
  await input(editor, 'Saved draft')
  let finish!: () => void
  vi.mocked(api.writeFile).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const newPlugin = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'New plugin')!
  await click('Save')
  expect(editor.disabled).toBe(true)
  expect(newPlugin.disabled).toBe(false)
  expect(container.querySelector<HTMLButtonElement>('[aria-label="New text file"]')!.disabled).toBe(false)
  await click('Agents')
  await click('Discard changes', document.querySelector('[role="dialog"]')!)
  await act(async () => finish())
  expect(container.querySelector('[aria-label="Plugin sections"] [aria-current="page"]')?.textContent).toBe('Agents')
  expect(container.querySelector('#plugin-file-editor')).toBeNull()
})

it('scopes dialog submission progress to its own controls', async () => {
  await click('New plugin')
  const dialog = document.querySelector('[role="dialog"]')!
  const inputField = dialog.querySelector('input')!
  await input(inputField, 'Pending plugin')
  let finish!: () => void
  vi.mocked(api.create).mockImplementationOnce(async (name, description) => {
    await new Promise<void>(resolve => { finish = resolve })
    state.plugins.push({ ...structuredClone(state.plugins[0]), id: 'pending', name, description })
    return 'pending'
  })
  const newPlugin = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'New plugin')!
  await click('Create plugin', dialog)
  expect(inputField.disabled).toBe(true)
  expect(dialog.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!.disabled).toBe(true)
  expect(newPlugin.disabled).toBe(false)
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open plugin folder"]')!.disabled).toBe(false)
  await act(async () => finish())
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('keeps an existing preview and file actions mounted when reloading the same file', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  const editButton = container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  let finish!: () => void
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve({ ...file }) }))
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  expect(editButton.isConnected).toBe(true)
  expect(container.textContent).not.toContain('Loading file')
  await act(async () => finish())
  expect(editButton.isConnected).toBe(true)
})


it('preserves edits started while a same-file reload is pending', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  let finish!: () => void
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve({ ...file }) }))
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click())
  await input(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')!, 'Newer draft')
  await act(async () => finish())
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toBe('Newer draft')
})


it('keeps Save enabled for unchanged files and during saves while ignoring repeated clicks', async () => {
  await edit()
  const save = [...container.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Save')!
  expect(save.disabled).toBe(false)
  expect(container.textContent).not.toContain('Reload file')
  let finish!: () => void
  vi.mocked(api.writeFile).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await act(async () => { save.click(); save.click() })
  expect(api.writeFile).toHaveBeenCalledTimes(1)
  expect(save.disabled).toBe(false)
  expect(save.getAttribute('aria-busy')).toBe('true')
  await act(async () => finish())
  expect(container.querySelector('#plugin-file-editor')).toBeNull()
})


it('updates externally changed previews in place without dimming buttons', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  const editButton = container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!
  vi.mocked(api.readFile).mockResolvedValueOnce({ ...file, content: '# Updated externally', revision: 'external' })
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect(api.readFile).toHaveBeenLastCalledWith('review', file.path)
  expect(container.querySelector('.plugin-detail-content')?.textContent).toContain('Updated externally')
  expect(container.querySelector('.plugin-detail-content')?.textContent).not.toContain('Read the diff.')
  expect(editButton.isConnected).toBe(true)
  expect(editButton.disabled).toBe(false)
  expect(container.querySelector('#plugin-file-editor')).toBeNull()
})

it('refreshes the selected supporting file after external changes', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  const picker = container.querySelector<HTMLSelectElement>('[aria-label="Skill file"]')!
  const path = 'skills/review-instructions/references/checklist.txt'
  await act(async () => { picker.value = path; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  vi.mocked(api.readFile).mockResolvedValueOnce({ path, content: 'New supporting text', revision: 'external-reference' })
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect(api.readFile).toHaveBeenLastCalledWith('review', path)
  expect(container.querySelector('.plugin-file-content')?.textContent).toBe('New supporting text')
  expect(picker.value).toBe(path)
})

it('preserves local drafts and their original revisions when external changes arrive', async () => {
  await input(await edit(), 'Local unsaved draft')
  await act(async () => emit({ type: 'pluginsChanged' }))
  expect(api.readFile).toHaveBeenCalledTimes(1)
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toBe('Local unsaved draft')
  await click('Save')
  expect(api.writeFile).toHaveBeenCalledWith('review', { ...file, content: 'Local unsaved draft' })
})

it('does not replace edits started while an external refresh is pending', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  let finish!: () => void
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve({ ...file, content: 'External text', revision: 'external' }) }))
  await act(async () => emit({ type: 'pluginsChanged' }))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Edit file"]')!.click())
  await input(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')!, 'New local edits')
  await act(async () => finish())
  expect(container.querySelector<HTMLTextAreaElement>('#plugin-file-editor')?.value).toBe('New local edits')
})

it('ignores external preview responses after navigation', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  let finish!: () => void
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise(resolve => { finish = () => resolve({ ...file, content: 'External text', revision: 'external' }) }))
  await act(async () => emit({ type: 'pluginsChanged' }))
  await click('Agents')
  await act(async () => finish())
  expect(container.querySelector('[aria-label="Plugin sections"] [aria-current="page"]')?.textContent).toBe('Agents')
  expect(container.querySelector('.plugin-detail-content')?.textContent).not.toContain('External text')
})

it('keeps the newest external refresh when responses arrive out of order', async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('.plugin-component')!.click())
  let finishOld!: () => void
  vi.mocked(api.readFile).mockReturnValueOnce(new Promise(resolve => { finishOld = () => resolve({ ...file, content: 'Old external text', revision: 'old' }) }))
  await act(async () => emit({ type: 'pluginsChanged' }))
  vi.mocked(api.readFile).mockResolvedValueOnce({ ...file, content: 'Newest external text', revision: 'newest' })
  await act(async () => emit({ type: 'pluginsChanged' }))
  await act(async () => finishOld())
  expect(container.querySelector('.plugin-detail-content')?.textContent).toContain('Newest external text')
  expect(container.querySelector('.plugin-detail-content')?.textContent).not.toContain('Old external text')
})


it('saves without adding a page-wide success banner', async () => {
  await input(await edit(), 'Updated instructions')
  await click('Save')
  expect(api.writeFile).toHaveBeenCalledWith('review', { ...file, content: 'Updated instructions' })
  expect(container.querySelector('[role="status"]')).toBeNull()
  expect(container.querySelector('#plugin-file-editor')).toBeNull()
})
