// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it('opens local links only on click, prevents navigation, and shows editor failures', async () => {
  const openFileLink = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(window, 'gloss', { configurable: true, value: { openFileLink } })
  const el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  await act(async () => root!.render(<Markdown text="[plan](/C:/work/MILESTONES.md:146)" />))
  expect(openFileLink).not.toHaveBeenCalled()
  const link = el.querySelector('a')!
  const click = new MouseEvent('click', { bubbles: true, cancelable: true })
  await act(async () => { link.dispatchEvent(click) })
  expect(click.defaultPrevented).toBe(true)
  expect(openFileLink).toHaveBeenCalledExactlyOnceWith('/C:/work/MILESTONES.md:146')

  openFileLink.mockRejectedValueOnce(new Error('File no longer exists'))
  await act(async () => link.click())
  expect(el.querySelector('[role="alert"]')?.textContent).toContain('File no longer exists')
  await act(async () => link.click())
  expect(el.querySelector('[role="alert"]')).toBeNull()
})
