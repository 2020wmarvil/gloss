// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/ipc'
import { UpdateSettings } from './UpdateSettings'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
const check = vi.fn(async () => ({}))
const restart = vi.fn(async () => {})
const automatic = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, 'gloss', { configurable: true, value: { updates: { check, restart } } })
  const host = document.createElement('div')
  document.body.replaceChildren(host)
  root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()) })

function render(state: Omit<UpdateState, 'version'>, on = true): void {
  act(() => root.render(<UpdateSettings state={{ version: '1.0.0', ...state }} automatic={on} onAutomatic={automatic} now={10 * 60_000} />))
}
const status = (): string => document.querySelector('[role="status"]')!.textContent!
const button = (): HTMLButtonElement => document.querySelector('.update-control button')!

it('shows the version and when it was last checked, and checks on request', () => {
  render({ status: 'current', checkedAt: 5 * 60_000 })
  expect(document.querySelector('.setting-label')!.textContent).toBe('Version 1.0.0')
  expect(status()).toBe('Up to date. Checked 5m ago.')
  act(() => button().click())
  expect(check).toHaveBeenCalledOnce()
  act(() => document.querySelector<HTMLButtonElement>('#setting-autoUpdate')!.click())
  expect(automatic).toHaveBeenCalledWith(false)
})

it('shows progress, then restarts into the downloaded update', () => {
  render({ status: 'downloading', next: '1.2.0', percent: 40 })
  expect(status()).toBe('Downloading 1.2.0…')
  expect(document.querySelector('.update-progress')!.textContent).toBe('40%')
  render({ status: 'ready', next: '1.2.0' })
  expect(status()).toBe('1.2.0 is downloaded and installs when you restart.')
  act(() => button().click())
  expect(restart).toHaveBeenCalledOnce()
})

it('offers Try again after a failed check, and disables everything in a development build', () => {
  render({ status: 'error', error: "Couldn't check for updates: no internet connection." })
  expect(button().textContent).toBe('Try again')
  render({ status: 'unsupported', reason: 'dev' })
  expect(status()).toBe('Development build. Only installed copies update.')
  expect(button().disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('#setting-autoUpdate')!.disabled).toBe(true)
})
