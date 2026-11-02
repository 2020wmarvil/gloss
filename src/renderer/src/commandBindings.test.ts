// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { configureBindings, commandMatches } from './commandBindings'
afterEach(() => configureBindings({}))
const key = (key: string, extra = {}) => new KeyboardEvent('keydown', { key, ...extra })
it('applies rebinding, disabling and resetting immediately to existing handlers', () => {
  expect(commandMatches(key('s', { ctrlKey: true }), 'stash')).toBe(true)
  configureBindings({ shortcuts: { stash: 'Ctrl+Shift+K' } })
  expect(commandMatches(key('s', { ctrlKey: true }), 'stash')).toBe(false)
  expect(commandMatches(key('K', { ctrlKey: true, shiftKey: true }), 'stash')).toBe(true)
  configureBindings({ shortcuts: { stash: '' } })
  expect(commandMatches(key('s', { ctrlKey: true }), 'stash')).toBe(false)
  configureBindings({ shortcuts: {} })
  expect(commandMatches(key('s', { ctrlKey: true }), 'stash')).toBe(true)
})
it('keeps standard redo aliases fixed even with old overrides', () => {
  expect(commandMatches(key('z', { ctrlKey: true, shiftKey: true }), 'annotationRedo')).toBe(true)
  configureBindings({ shortcuts: { annotationRedo: 'Ctrl+K' } })
  expect(commandMatches(key('z', { ctrlKey: true, shiftKey: true }), 'annotationRedo')).toBe(true)
  expect(commandMatches(key('k', { ctrlKey: true }), 'annotationRedo')).toBe(false)
})
