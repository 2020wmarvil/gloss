// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { Popover } from './Popover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('switches menus with one click, keeps internal clicks open, and closes on outside clicks or Escape', async () => {
  const el = document.createElement('div')
  document.body.replaceChildren(el)
  const root = createRoot(el)
  try {
    await act(async () => root.render(<>
      <Popover label="Model">{() => <button>Model option</button>}</Popover>
      <Popover label="Effort">{() => <button>Effort option</button>}</Popover>
      <button className="outside">Folder</button>
    </>))
    const triggers = el.querySelectorAll<HTMLButtonElement>('.popover-anchor > button')
    const click = async (button: HTMLElement): Promise<void> => { await act(async () => button.click()) }
    await click(triggers[0])
    expect(el.querySelector('.popover')!.textContent).toBe('Model option')
    await click(triggers[1])
    expect(el.querySelectorAll('.popover')).toHaveLength(1)
    expect(triggers[0].getAttribute('aria-expanded')).toBe('false')
    expect(el.querySelector('.popover')!.textContent).toBe('Effort option')
    await click(el.querySelector('.popover button')!)
    expect(el.querySelector('.popover')).not.toBeNull()
    await click(triggers[1])
    expect(el.querySelector('.popover')).toBeNull()
    await click(triggers[0])
    await click(el.querySelector('.outside')!)
    expect(el.querySelector('.popover')).toBeNull()
    await click(triggers[0])
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(el.querySelector('.popover')).toBeNull()
  } finally {
    act(() => root.unmount())
  }
})
