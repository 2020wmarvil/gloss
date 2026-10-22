// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentProfileSettings } from './AgentProfileSettings'
import type { AgentProfile } from '@shared/agentProfiles'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()) })
const profile: AgentProfile = { id: 'custom:example', name: 'Example', command: '/bin/agent', args: ['--instructions', '{instructions}'], env: { API_KEY: 'MY_AGENT_KEY' } }

it('keeps profile IDs fixed and saves only after successful connection, showing capabilities', async () => {
  const testProfile = vi.fn()
    .mockResolvedValueOnce({ available: false, error: 'Could not connect' })
    .mockResolvedValueOnce({ available: true, version: '1.2', capabilities: { resume: false, discovery: true, images: false, context: true, steering: false } })
  window.gloss = { agents: { testProfile } } as unknown as typeof window.gloss
  const save = vi.fn(async () => {})
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<AgentProfileSettings profiles={[profile]} defaultAgent="claude" onSave={save} />))
  await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Edit Example"]')!.click())
  expect(el.querySelector<HTMLInputElement>('#profile-id')!.disabled).toBe(true)
  await act(async () => el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(save).not.toHaveBeenCalled()
  expect(el.querySelector('[role="alert"]')?.textContent).toContain('Could not connect')
  await act(async () => el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(testProfile).toHaveBeenLastCalledWith(profile)
  expect(save).toHaveBeenCalledWith([profile])
  expect(el.querySelector('[role="status"] details')?.hasAttribute('open')).toBe(false)
  expect(el.querySelector('[role="status"] dl')?.textContent).toContain('ResumeUnavailable')
  expect(el.querySelector('form')).toBeNull()
})

it('removes a default profile and requests a built-in default without deleting conversations', async () => {
  const save = vi.fn(async () => {})
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<AgentProfileSettings profiles={[profile]} defaultAgent={profile.id} onSave={save} />))
  await act(async () => el.querySelector<HTMLButtonElement>('[title="Actions for Example"]')!.click())
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent?.startsWith('Remove'))!.click())
  expect(save).toHaveBeenCalledWith([], true)
})

it('creates a unique ID from the name and keeps advanced configuration collapsed', async () => {
  const testProfile = vi.fn(async () => ({ available: true, version: '1.0', capabilities: null }))
  window.gloss = { agents: { testProfile } } as unknown as typeof window.gloss
  const save = vi.fn(async () => {})
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<AgentProfileSettings profiles={[profile]} defaultAgent={profile.id} onSave={save} />))
  expect(el.querySelector('.acp-default')?.textContent).toBe('Default')
  expect(el.querySelector('.acp-list')?.textContent).not.toContain(profile.id)
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Add agent')!.click())
  expect(el.querySelector('.acp-advanced')?.hasAttribute('open')).toBe(false)
  const input = async (selector: string, text: string): Promise<void> => act(async () => {
    const field = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    const proto = field.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await input('#profile-name', 'Example')
  expect(el.querySelector<HTMLInputElement>('#profile-id')?.value).toBe('custom:example-2')
  await input('#profile-command', '/bin/other-agent')
  await input('#profile-args', '["--instructions", "{instructions}"]')
  await act(async () => el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(testProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'custom:example-2', name: 'Example' }))
  expect(save).toHaveBeenCalledWith([profile, expect.objectContaining({ id: 'custom:example-2' })])
})

it('preserves list order on edit and makes cancel return without saving', async () => {
  window.gloss = { agents: { testProfile: vi.fn(async () => ({ available: true, capabilities: null })) } } as unknown as typeof window.gloss
  const other = { ...profile, id: 'custom:other', name: 'Other' }
  const save = vi.fn(async () => {})
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<AgentProfileSettings profiles={[profile, other]} defaultAgent="claude" onSave={save} />))
  await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Edit Example"]')!.click())
  await act(async () => el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(save).toHaveBeenCalledWith([profile, other])
  save.mockClear()
  await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Edit Other"]')!.click())
  await act(async () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!.click())
  expect(el.querySelector('form')).toBeNull()
  expect(save).not.toHaveBeenCalled()
})
