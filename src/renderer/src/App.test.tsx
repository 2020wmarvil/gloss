// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
})
import { App } from './App'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); vi.unstubAllGlobals() })

it('uses the default agent for creation and keeps external sessions separated when switching agents', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const list = vi.fn(async (_path: string, agentId: string) => [{ acpSessionId: 'same-id', title: `${agentId} external` }])
  const create = vi.fn(async () => { throw new Error('creation observed') })
  const importSession = vi.fn(async () => { throw new Error('import observed') })
  window.gloss = {
    settings: { get: async () => ({ global: { defaultAgent: 'codex', theme: 'light', sessionOrder: 'created' }, projects: {}, error: null, path: '/settings.json' }) },
    agents: { list: async () => [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }] },
    projects: { list: async () => [{ path: '/project', name: 'project' }], agentSessions: list },
    sessions: { list: async () => [], create, import: importSession },
    onEvent: () => () => {}
  } as unknown as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  await act(async () => root!.render(<App />))
  const picker = el.querySelector('select[aria-label="Agent for new sessions"]') as HTMLSelectElement
  expect(picker.value).toBe('codex')
  expect(list).toHaveBeenCalledWith('/project', 'codex')
  expect(el.textContent).toContain('codex external')
  await act(async () => (el.querySelector('.new-session') as HTMLButtonElement).click())
  expect(create).toHaveBeenCalledWith('/project', 'codex')
  await act(async () => { picker.value = 'claude'; picker.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(el.textContent).toContain('claude external')
  expect(el.textContent).not.toContain('codex external')
  await act(async () => (el.querySelector('.session-row.agent') as HTMLButtonElement).click())
  expect(importSession).toHaveBeenCalledWith('/project', 'claude', 'same-id', 'claude external', undefined)
})
