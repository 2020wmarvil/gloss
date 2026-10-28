// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { Session, Worktree } from '@shared/types'
import { WorktreesScreen } from './WorktreesScreen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
afterEach(() => host.remove())

const worktrees: Worktree[] = [
  { path: '/p', branch: 'dev', main: true, work: { uncommitted: 2, unpushed: 0, pr: null, unfinished: true } },
  { path: '/w/clean', branch: 'gloss/k3f9', work: { uncommitted: 0, unpushed: 0, pr: null, unfinished: false } },
  { path: '/w/dirty', branch: 'gloss/p82d', work: { uncommitted: 3, unpushed: 2, pr: null, unfinished: true } },
  { path: '/w/merged', branch: 'gloss/m1qa', work: { uncommitted: 0, unpushed: 2, pr: { number: 58, state: 'merged', url: 'https://github.com/o/r/pull/58' }, unfinished: false } }
]
const sessions: Session[] = [
  { id: 's1', agentId: 'claude', acpSessionId: 'a', cwd: '/w/merged', project: '/p', title: 'Rewind polish', createdAt: 1 }
]

function mount(props: Partial<Parameters<typeof WorktreesScreen>[0]> = {}): { el: HTMLDivElement; calls: Record<string, ReturnType<typeof vi.fn>> } {
  host = document.createElement('div')
  document.body.append(host)
  const calls = {
    onSetPlace: vi.fn(), onNewSession: vi.fn(), onReview: vi.fn(), onRemove: vi.fn(async () => {}),
    onOpenSession: vi.fn(), onOpenSettings: vi.fn(), onClose: vi.fn()
  }
  act(() =>
    createRoot(host).render(
      <WorktreesScreen
        project={{ path: '/p', name: 'p', where: '~' }}
        worktrees={worktrees}
        sessions={sessions}
        running={{}}
        place="folder"
        base=""
        setup="npm install"
        error={null}
        {...calls}
        {...props}
      />
    )
  )
  return { el: host, calls }
}

const card = (el: HTMLElement, branch: string): HTMLElement =>
  [...el.querySelectorAll<HTMLElement>('.worktree')].find((w) => w.querySelector('.worktree-branch')!.textContent!.includes(branch))!

it('lists the project folder and each worktree with what it holds and its sessions', () => {
  const { el, calls } = mount()
  expect(el.querySelector('.lede')!.textContent).toContain('npm install')
  expect(card(el, 'dev').querySelector('.worktree-state')!.textContent).toBe('2 uncommitted files')
  // The project folder has no Remove.
  expect(card(el, 'dev').textContent).not.toContain('Remove')
  expect(card(el, 'gloss/k3f9').querySelector('.worktree-state')!.textContent).toBe('Clean')
  expect(card(el, 'gloss/p82d').querySelector('.worktree-state')!.textContent).toBe('3 uncommitted files2 unpushed commits')
  expect(card(el, 'gloss/p82d').textContent).toContain('Its work is kept until you remove it')
  // Merged at its commit: its commits aren't counted as unpushed.
  expect(card(el, 'gloss/m1qa').querySelector('.worktree-state')!.textContent).toBe('PR #58 merged')
  act(() => card(el, 'gloss/m1qa').querySelector<HTMLButtonElement>('.worktree-chip')!.click())
  expect(calls.onOpenSession).toHaveBeenCalledWith('s1')
  act(() => card(el, 'gloss/k3f9').querySelector<HTMLButtonElement>('.worktree-star')!.click())
  expect(calls.onSetPlace).toHaveBeenCalledWith('/w/clean')
})

it('removes a clean worktree at once, and asks first when something would be lost', async () => {
  const { el, calls } = mount()
  const remove = (branch: string): HTMLButtonElement =>
    [...card(el, branch).querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Remove')!
  await act(async () => remove('gloss/k3f9').click())
  expect(calls.onRemove).toHaveBeenCalledWith('/w/clean')
  await act(async () => remove('gloss/m1qa').click())
  const dialog = el.querySelector('[role="alertdialog"]')!
  expect(dialog.textContent).toContain('Session “Rewind polish”')
  await act(async () => dialog.querySelector<HTMLButtonElement>('button.danger')!.click())
  expect(calls.onRemove).toHaveBeenLastCalledWith('/w/merged')
  await act(async () => remove('gloss/p82d').click())
  expect(el.querySelector('[role="alertdialog"] ul')!.textContent).toBe('3 uncommitted files2 unpushed commits')
  await act(async () => el.querySelector<HTMLButtonElement>('[role="alertdialog"] button.ghost')!.click())
  expect(calls.onRemove).toHaveBeenCalledTimes(2)
})
