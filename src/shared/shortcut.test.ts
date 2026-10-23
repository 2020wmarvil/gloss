import { expect, it } from 'vitest'
import { normalizeShortcut, shortcutFromKey, shortcutKeys, type KeyPress } from './shortcut'

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })

it('reads a shortcut from a key press, modifiers in a fixed order', () => {
  expect(shortcutFromKey(press('KeyS', { shiftKey: true, ctrlKey: true, altKey: true }))).toEqual({ accelerator: 'Ctrl+Alt+Shift+S' })
  expect(shortcutFromKey(press('Digit2', { metaKey: true, shiftKey: true }))).toEqual({ accelerator: 'Shift+Super+2' })
  expect(shortcutFromKey(press('PrintScreen'))).toEqual({ accelerator: 'PrintScreen' })
  expect(shortcutFromKey(press('F9', { shiftKey: true }))).toEqual({ accelerator: 'Shift+F9' })
  expect(shortcutFromKey(press('ArrowUp', { altKey: true }))).toEqual({ accelerator: 'Alt+Up' })
  expect(shortcutFromKey(press('Numpad5', { ctrlKey: true }))).toEqual({ accelerator: 'Ctrl+num5' })
})

it('waits while only modifiers are held, and refuses keys that would stop typing', () => {
  expect(shortcutFromKey(press('ControlLeft', { ctrlKey: true }))).toBeNull()
  expect(shortcutFromKey(press('ShiftRight', { shiftKey: true, ctrlKey: true }))).toBeNull()
  expect(shortcutFromKey(press('KeyS'))).toHaveProperty('error')
  expect(shortcutFromKey(press('KeyS', { shiftKey: true }))).toHaveProperty('error')
  expect(shortcutFromKey(press('Escape', { ctrlKey: true }))).toHaveProperty('error')
  expect(shortcutFromKey(press('IntlRo', { ctrlKey: true }))).toHaveProperty('error')
})

it('cleans up shortcuts typed into settings.json, and rejects ones that are not', () => {
  expect(normalizeShortcut('ctrl + shift + printscreen')).toBe('Ctrl+Shift+PrintScreen')
  expect(normalizeShortcut('CommandOrControl+Alt+S')).toBe('Ctrl+Alt+S')
  expect(normalizeShortcut('Shift+Ctrl+Alt+s')).toBe('Ctrl+Alt+Shift+S')
  expect(normalizeShortcut('Cmd+Shift+4')).toBe('Shift+Super+4')
  expect(normalizeShortcut('Ctrl++')).toBe('Ctrl+Plus')
  expect(normalizeShortcut('F12')).toBe('F12')
  expect(normalizeShortcut('S')).toBeNull()
  expect(normalizeShortcut('Shift+S')).toBeNull()
  expect(normalizeShortcut('Ctrl+Banana')).toBeNull()
  expect(normalizeShortcut('Hyper+S')).toBeNull()
  expect(normalizeShortcut('Ctrl+Esc')).toBeNull()
  expect(normalizeShortcut('')).toBeNull()
})

it('shows a shortcut as keys', () => {
  expect(shortcutKeys('Ctrl+Shift+PrintScreen')).toEqual(['Ctrl', 'Shift', 'PrtSc'])
  expect(shortcutKeys('Shift+Super+4')).toEqual(['Shift', 'Win', '4'])
  expect(shortcutKeys('Shift+Super+4', true)).toEqual(['Shift', 'Cmd', '4'])
})
