// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { configureBindings, commandMatches } from './commandBindings'
afterEach(() => configureBindings({}))
const key = (key: string, extra = {}) => new KeyboardEvent('keydown', { key, ...extra })
it('applies rebinding, disabling and resetting immediately to existing handlers', () => {
  expect(commandMatches(key('b', { ctrlKey: true }), 'bold')).toBe(true)
  configureBindings({ shortcuts: { bold: 'Ctrl+Shift+K' } })
  expect(commandMatches(key('b', { ctrlKey: true }), 'bold')).toBe(false)
  expect(commandMatches(key('K', { ctrlKey: true, shiftKey: true }), 'bold')).toBe(true)
  configureBindings({ shortcuts: { bold: '' } })
  expect(commandMatches(key('b', { ctrlKey: true }), 'bold')).toBe(false)
  configureBindings({ shortcuts: {} })
  expect(commandMatches(key('b', { ctrlKey: true }), 'bold')).toBe(true)
})
it('preserves default redo aliases, but removes them when customized', () => {
  expect(commandMatches(key('z', { ctrlKey: true, shiftKey: true }), 'annotationRedo')).toBe(true)
  configureBindings({ shortcuts: { annotationRedo: 'Ctrl+K' } })
  expect(commandMatches(key('z', { ctrlKey: true, shiftKey: true }), 'annotationRedo')).toBe(false)
  expect(commandMatches(key('k', { ctrlKey: true }), 'annotationRedo')).toBe(true)
})
