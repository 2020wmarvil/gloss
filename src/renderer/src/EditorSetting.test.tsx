// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_EXTERNAL_EDITOR } from '@shared/settings'
import { EditorSetting } from './EditorSetting'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(() => { act(() => root?.unmount()) })

it('selects editor presets and saves custom commands without changing them on open', async () => {
  const saved = vi.fn()
  function Harness(): React.JSX.Element {
    const [value, setValue] = useState(DEFAULT_EXTERNAL_EDITOR)
    return <EditorSetting id="editor" value={value} onChange={(next) => { saved(next); setValue(next) }} />
  }
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<Harness />))
  expect(el.querySelector('button')?.textContent).toBe('Visual Studio Code')
  expect(saved).not.toHaveBeenCalled()
  const pick = async (label: string): Promise<void> => {
    await act(async () => el.querySelector('button')!.click())
    await act(async () => [...el.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === label)!.click())
  }
  await pick('Notepad++')
  expect(saved).toHaveBeenLastCalledWith('notepad++ -n{line} {file}')
  await pick('Custom command...')
  const input = el.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'my-editor --line {line} {file}')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(saved).toHaveBeenLastCalledWith('my-editor --line {line} {file}')
  expect(el.querySelector('input')?.value).toBe('my-editor --line {line} {file}')
  await pick('System default app')
  expect(saved).toHaveBeenLastCalledWith('')
  expect(el.querySelector('input')).toBeNull()
})

it('preserves custom commands and updates the selection when settings reload', async () => {
  const save = vi.fn()
  const el = document.createElement('div')
  root = createRoot(el)
  await act(async () => root!.render(<EditorSetting id="editor" value={'"C:/My Editor/editor.exe" {file}'} onChange={save} />))
  expect(el.querySelector('input')?.value).toBe('"C:/My Editor/editor.exe" {file}')
  expect(save).not.toHaveBeenCalled()
  await act(async () => root!.render(<EditorSetting id="editor" value={DEFAULT_EXTERNAL_EDITOR} onChange={save} />))
  expect(el.querySelector('button')?.textContent).toBe('Visual Studio Code')
  expect(el.querySelector('input')).toBeNull()
  expect(save).not.toHaveBeenCalled()
})
