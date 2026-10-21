// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Select, Switch } from './Select'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
afterEach(() => host.remove())

function mount(node: React.ReactNode): HTMLDivElement {
  host = document.createElement('div')
  document.body.append(host)
  act(() => createRoot(host).render(node))
  return host
}

const key = (el: Element, k: string): void => {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
}

const options = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana', disabled: true },
  { value: 'c', label: 'Cherry' }
]

it('opens its own menu, marks the current option and picks with the mouse', () => {
  const onChange = vi.fn()
  const el = mount(<Select ariaLabel="Fruit" value="a" options={options} onChange={onChange} />)
  const button = el.querySelector('button')!
  expect(button.textContent).toBe('Apple')
  act(() => button.click())
  const items = [...el.querySelectorAll('[role="option"]')]
  expect(items.map((i) => i.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
  act(() => (items[1] as HTMLElement).click())
  expect(onChange).not.toHaveBeenCalled()
  act(() => (items[2] as HTMLElement).click())
  expect(onChange).toHaveBeenCalledWith('c')
  expect(el.querySelector('[role="listbox"]')).toBeNull()
})

it('moves past disabled options with the arrows and picks with Enter; Escape closes', () => {
  const onChange = vi.fn()
  const el = mount(<Select ariaLabel="Fruit" value="a" options={options} onChange={onChange} />)
  const button = el.querySelector('button')!
  key(button, 'ArrowDown')
  expect(el.querySelector('[role="listbox"]')).not.toBeNull()
  key(button, 'ArrowDown')
  expect(el.querySelector('.active')!.textContent).toBe('Cherry')
  key(button, 'Escape')
  expect(el.querySelector('[role="listbox"]')).toBeNull()
  key(button, 'ArrowDown')
  key(button, 'ArrowDown')
  key(button, 'Enter')
  expect(onChange).toHaveBeenCalledWith('c')
})

it('toggles a switch', () => {
  const onChange = vi.fn()
  const el = mount(<Switch ariaLabel="Replies" checked={false} onChange={onChange} />)
  const sw = el.querySelector('[role="switch"]')!
  expect(sw.getAttribute('aria-checked')).toBe('false')
  act(() => (sw as HTMLElement).click())
  expect(onChange).toHaveBeenCalledWith(true)
})
