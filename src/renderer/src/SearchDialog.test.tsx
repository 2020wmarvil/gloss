// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SearchDialog } from './SearchDialog'
import type { SearchResponse, SearchResult } from '@shared/search'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()); vi.useRealTimers() })
const result: SearchResult = { id: 'm', sessionId: 's', sessionTitle: 'Project discussion', cwd: '/project', kind: 'agent', threadId: 't', threadQuote: 'Cache format', snippet: 'Use \u0001cache\u0002 <script>bad()</script>' }

async function mount(search: (request: unknown) => Promise<SearchResponse>, onOpen = vi.fn(async () => {})): Promise<{ el: HTMLDivElement; input: HTMLInputElement; close: ReturnType<typeof vi.fn>; onOpen: typeof onOpen }> {
  vi.useFakeTimers()
  window.gloss = { search } as typeof window.gloss
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  root = createRoot(el)
  const close = vi.fn()
  await act(async () => root!.render(<SearchDialog sessionId="s" cwd="/project" onClose={close} onOpen={onOpen} />))
  return { el, input: el.querySelector('input')!, close, onOpen }
}
async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => vi.advanceTimersByTimeAsync(151))
}

it('searches with scope and type filters, highlights plain text safely, and opens a result', async () => {
  const search = vi.fn(async () => ({ results: [result], more: true }))
  const { el, input, onOpen, close } = await mount(search)
  expect(document.activeElement).toBe(input)
  await type(input, 'cache')
  expect(search).toHaveBeenCalledWith({ query: 'cache', scope: 'all', kind: 'all', sessionId: 's', cwd: '/project' })
  expect(el.querySelector('mark')!.textContent).toBe('cache')
  expect(el.querySelector('script')).toBeNull()
  expect(el.textContent).toContain('Showing the first 100')
  // The filters are Gloss's own dropdowns: open one, then pick an option.
  const pick = async (label: string, option: string): Promise<void> => {
    await act(async () => (el.querySelector(`.select-button[aria-label="${label}"]`) as HTMLButtonElement).click())
    const item = [...el.querySelectorAll('[role="option"]')].find((o) => o.textContent === option) as HTMLElement
    await act(async () => item.click())
  }
  await pick('Search in', 'Current project')
  await pick('Show', 'Tool output')
  await act(async () => vi.advanceTimersByTimeAsync(151))
  expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'project', kind: 'tool' }))
  await act(async () => (el.querySelector('.search-result') as HTMLButtonElement).click())
  expect(onOpen).toHaveBeenCalledWith(result)
  expect(close).toHaveBeenCalled()
})

it('discards an older response, clears stale results, and reports errors', async () => {
  let finish!: (response: SearchResponse) => void
  const search = vi.fn().mockImplementationOnce(() => new Promise<SearchResponse>((resolve) => { finish = resolve })).mockRejectedValueOnce(new Error('Search unavailable'))
  const { el, input } = await mount(search)
  await type(input, 'old')
  await type(input, 'new')
  await act(async () => finish({ results: [result], more: false }))
  expect(el.querySelector('.search-result')).toBeNull()
  expect(el.querySelector('[role="alert"]')!.textContent).toContain('Search unavailable')
  await type(input, '')
  expect(el.querySelector('[role="alert"]')).toBeNull()
  expect(el.textContent).toContain('Enter words')
})

it('traps focus and closes on Escape without forwarding it to the working composer', async () => {
  const { el, input, close } = await mount(async () => ({ results: [], more: false }))
  const last = el.querySelector('.select-button[aria-label="Show"]') as HTMLButtonElement
  last.focus()
  await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(input)
  const bubbled = vi.fn()
  window.addEventListener('keydown', bubbled)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(close).toHaveBeenCalled()
  expect(bubbled).not.toHaveBeenCalled()
  window.removeEventListener('keydown', bubbled)
})

it('groups results by session and shows inline code and bold without their markers', async () => {
  const other: SearchResult = { ...result, id: 'n', sessionId: 'o', sessionTitle: 'Other', snippet: 'call `\u0001cache\u0002.get()` **now**' }
  const { el, input } = await mount(async () => ({ results: [result, other, { ...result, id: 'p', threadQuote: null }], more: false }))
  await type(input, 'cache')
  expect([...el.querySelectorAll('.search-group-head b')].map((b) => b.textContent)).toEqual(['Project discussion', 'Other'])
  expect(el.querySelector('.search-group-head span')!.textContent).toBe('project · 2 results')
  const snippet = [...el.querySelectorAll('.search-snippet')].find((s) => s.textContent!.startsWith('call'))!
  expect(snippet.innerHTML).toBe('call <code><mark>cache</mark>.get()</code> now')
  // Arrows move through the groups in order; Enter opens the highlighted result.
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(el.querySelector('.search-result.active .search-where')!.textContent).toBe('Agent · Main conversation')
})
