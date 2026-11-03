// @vitest-environment jsdom
// SPEC → Performance: highlighting arriving re-renders code as a transition, so coloring
// every visible code block doesn't hold up a paint in one long task.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

const transitions = vi.hoisted(() => ({ count: 0 }))
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>()
  return { ...react, startTransition: (fn: () => void) => { transitions.count++; react.startTransition(fn) } }
})
import { codeColors, useHighlighting } from './highlight'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('re-renders users of highlighting in a transition when it becomes available', async () => {
  const seen: number[] = []
  function Probe(): null {
    seen.push(useHighlighting())
    return null
  }
  const el = document.createElement('div')
  const root = createRoot(el)
  act(() => root.render(<Probe />))
  const before = seen.at(-1)!
  // Asking for a language not loaded yet loads it; that update arrives as a transition.
  await vi.waitFor(() => {
    codeColors('let x = 1', 'rust')
    expect(codeColors('let x = 1', 'rust')).not.toBeNull()
  }, { timeout: 10000 })
  await act(async () => {})
  expect(seen.at(-1)).toBeGreaterThan(before)
  expect(transitions.count).toBeGreaterThan(0)
  act(() => root.unmount())
})
